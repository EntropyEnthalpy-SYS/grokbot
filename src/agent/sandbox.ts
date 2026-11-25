import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Semaphore } from "../media/run.ts";

/**
 * run_code: Python in a locked box (bubblewrap) for exact calculations, data and charts. Each run gets
 * a fresh box: no network at all, no view of the bot's files (only the system's programs, the Python
 * environment and its own work folder), and limits on time, memory, file size and output. Files it
 * saves are posted after the answer.
 */

export interface SandboxFile {
  name: string;
  data: Buffer;
}

export interface CodeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  files: SandboxFile[];
}

const OUTPUT_CHARS = 8_000;
const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RUNNER = ".run.py";

/** Sets up matplotlib (no screen, Chinese fonts) only when the code uses it, runs main.py, and saves charts left unsaved. */
const RUNNER_SOURCE = `import os, sys, runpy
os.makedirs("out", exist_ok=True)
code = open("main.py", encoding="utf-8").read()
if "matplotlib" in code or "plt." in code or "pandas" in code:
    try:
        import matplotlib
        matplotlib.use("Agg")
        from matplotlib import font_manager
        fonts = os.environ.get("FONT_DIR", "")
        if os.path.isdir(fonts):
            for root, _, names in os.walk(fonts):
                for f in sorted(names):
                    if f.endswith((".ttf", ".otf", ".ttc")) and ("CJK" in f or "SC" in f or "TC" in f or f.startswith("NotoSans-")):
                        font_manager.fontManager.addfont(os.path.join(root, f))
            matplotlib.rcParams["font.sans-serif"] = ["Noto Sans SC", "Noto Sans TC", "Noto Sans CJK SC", "Noto Sans"] + matplotlib.rcParams["font.sans-serif"]
            matplotlib.rcParams["axes.unicode_minus"] = False
    except ImportError:
        pass
try:
    runpy.run_path("main.py", run_name="__main__")
finally:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None and not os.listdir("out"):
        for i, n in enumerate(plt.get_fignums(), 1):
            plt.figure(n).savefig(f"out/chart{i}.png", dpi=150, bbox_inches="tight")
`;

export class CodeRunner {
  readonly #venv: string;
  readonly #bwrap: string;
  readonly #fontDir: string | undefined;
  readonly #workRoot: string;
  readonly #timeoutMs: number;
  readonly #memoryBytes: number;
  readonly #queue = new Semaphore(1);

  constructor(options: { venv: string; workRoot: string; bwrap?: string; fontDir?: string; timeoutMs?: number; memoryBytes?: number }) {
    this.#venv = options.venv;
    this.#workRoot = options.workRoot;
    this.#bwrap = options.bwrap ?? "/usr/bin/bwrap";
    this.#fontDir = options.fontDir;
    this.#timeoutMs = options.timeoutMs ?? 35_000;
    this.#memoryBytes = options.memoryBytes ?? 1024 * 1024 * 1024;
  }

  /** bubblewrap and the Python environment are installed (deploy.sh does both). */
  get available(): boolean {
    return existsSync(this.#bwrap) && existsSync(join(this.#venv, "bin", "python"));
  }

  /** One run at a time; the box and its folder are gone afterwards. */
  run(code: string, inputs: readonly SandboxFile[] = []): Promise<CodeResult> {
    return this.#queue.use(() => this.#run(code, inputs));
  }

  async #run(code: string, inputs: readonly SandboxFile[]): Promise<CodeResult> {
    await mkdir(this.#workRoot, { recursive: true });
    const dir = await mkdtemp(join(this.#workRoot, "run-"));
    try {
      const given = new Set<string>();
      for (const input of inputs) {
        const name = inputName(input.name, given);
        given.add(name);
        await writeFile(join(dir, name), input.data);
      }
      await writeFile(join(dir, "main.py"), code);
      await writeFile(join(dir, RUNNER), RUNNER_SOURCE);
      const started = Date.now();
      const result = await capture(this.#bwrap, this.#args(dir), this.#timeoutMs);
      const files = await collect(dir, new Set([...given, "main.py", RUNNER]));
      return { ...result, ms: Date.now() - started, files };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  #args(dir: string): string[] {
    const venv = this.#venv;
    const cpuSeconds = Math.max(1, Math.floor(this.#timeoutMs / 1000) - 5); // the CPU limit usually stops a loop first
    return [
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
      "--ro-bind", "/usr", "/usr",
      "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
      "--ro-bind-try", "/etc/fonts", "/etc/fonts",
      "--ro-bind-try", "/etc/localtime", "/etc/localtime",
      "--ro-bind", venv, venv,
      ...(this.#fontDir && existsSync(this.#fontDir) ? ["--ro-bind", this.#fontDir, this.#fontDir] : []),
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--bind", dir, "/work", "--chdir", "/work",
      "--setenv", "HOME", "/tmp", "--setenv", "MPLCONFIGDIR", "/tmp", "--setenv", "PATH", `${venv}/bin:/usr/bin`,
      "--setenv", "LANG", "C.UTF-8", "--setenv", "PYTHONIOENCODING", "utf-8", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
      "--setenv", "OPENBLAS_NUM_THREADS", "1", "--setenv", "OMP_NUM_THREADS", "1", "--setenv", "MPLBACKEND", "Agg",
      ...(this.#fontDir ? ["--setenv", "FONT_DIR", this.#fontDir] : []),
      "--",
      "/usr/bin/prlimit", `--as=${this.#memoryBytes}`, `--cpu=${cpuSeconds}`, `--fsize=${MAX_FILE_BYTES * 3}`, "--nofile=256", "--core=0",
      `${venv}/bin/python`, "-B", RUNNER,
    ];
  }
}

/** A safe, unique file name for an input in the work folder. */
function inputName(raw: string, taken: Set<string>): string {
  const base = raw.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 80) || "input";
  let name = base === "main.py" || base === RUNNER ? `input_${base}` : base;
  for (let i = 2; taken.has(name); i++) name = `${i}_${base}`;
  return name;
}

/** Run with a wall-clock limit (the whole box is killed) and capped output. */
function capture(program: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out = { stdout: "", stderr: "" };
    const take = (key: "stdout" | "stderr") => (chunk: Buffer) => {
      if (out[key].length < OUTPUT_CHARS * 4) out[key] += chunk.toString("utf8");
    };
    child.stdout.on("data", take("stdout"));
    child.stderr.on("data", take("stderr"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ ...out, exitCode, timedOut });
    });
  });
}

/** Files the code saved: in out/ and in the work folder itself (inputs and the program excluded). */
async function collect(dir: string, skip: Set<string>): Promise<SandboxFile[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && !skip.has(entry.name)) found.push(entry.name);
  }
  const outDir = join(dir, "out");
  if (existsSync(outDir)) {
    for (const entry of await readdir(outDir, { withFileTypes: true })) if (entry.isFile()) found.push(join("out", entry.name));
  }
  const files: SandboxFile[] = [];
  for (const path of found.slice(0, MAX_FILES)) {
    const full = join(dir, path);
    if ((await stat(full)).size > MAX_FILE_BYTES) continue;
    files.push({ name: path.replace(/^out\//, ""), data: await readFile(full) });
  }
  return files;
}

interface CodeTurn {
  readonly key: string;
  /** Names of the files attached to the question, and how to fetch them (only when code runs). */
  readonly attached: { names: string[]; load: () => Promise<SandboxFile[]> };
  inputs?: Promise<SandboxFile[]>;
  readonly outputs: Map<string, Buffer>;
  runs: number;
}

const RUNS_PER_TURN = 5;
const CodeParams = Type.Object({ code: Type.String({ description: "A complete Python 3 program. print() what you need to see." }) });
type CodeToolResult = Awaited<ReturnType<AgentTool<typeof CodeParams, undefined>["execute"]>>;
const toolResult = (text: string, isError = false): CodeToolResult => ({ content: [{ type: "text", text }], details: undefined, isError });

/** run_code for each running answer; the files the code saved are posted after the answer. */
export class CodeDesk {
  readonly #runner: CodeRunner;
  readonly #turns = new Map<string, CodeTurn>();

  constructor(runner: CodeRunner) {
    this.#runner = runner;
  }

  get available(): boolean {
    return this.#runner.available;
  }

  /** Call when an answer starts (turns of one chat never overlap). */
  begin(key: string, attached: CodeTurn["attached"] = { names: [], load: async () => [] }): CodeTurn {
    const turn: CodeTurn = { key, attached, outputs: new Map(), runs: 0 };
    this.#turns.set(key, turn);
    return turn;
  }

  /** Call when the answer is done; returns the files to post. */
  end(turn: CodeTurn): SandboxFile[] {
    if (this.#turns.get(turn.key) === turn) this.#turns.delete(turn.key);
    return [...turn.outputs].map(([name, data]) => ({ name, data }));
  }

  tool(key: string): AgentTool<typeof CodeParams, undefined> {
    const names = this.#turns.get(key)?.attached.names ?? [];
    return {
      name: "run_code",
      label: "Running code",
      description:
        "Run Python 3 in a sandbox: no internet, about 30 s and 1 GB, packages numpy, pandas, matplotlib, sympy, openpyxl. " +
        "Use it for exact arithmetic, statistics, unit or date calculations, data in attached CSV/Excel files, and charts: " +
        "don't do such math in your head. print() results. Save charts or files into out/ (e.g. plt.savefig('out/chart.png')): " +
        "they are posted right after your reply. Chinese text in charts works. " +
        (names.length ? `Files attached to this question are in the current folder: ${names.join(", ")}.` : "No files are attached to this question."),
      parameters: CodeParams,
      execute: async (_id, { code }) => {
        const turn = this.#turns.get(key);
        if (!turn) return toolResult("Code can't run here.", true);
        if (++turn.runs > RUNS_PER_TURN) return toolResult(`At most ${RUNS_PER_TURN} runs per answer. Answer with what you have.`, true);
        let inputs: SandboxFile[];
        try {
          inputs = await (turn.inputs ??= turn.attached.load());
        } catch (error) {
          return toolResult(`Couldn't get the attached files: ${(error as Error).message}`, true);
        }
        const result = await this.#runner.run(code, inputs);
        for (const file of result.files) if (turn.outputs.size < MAX_FILES || turn.outputs.has(file.name)) turn.outputs.set(file.name, file.data);
        return toolResult(describeRun(result), result.exitCode !== 0);
      },
    };
  }
}

export function describeRun(result: CodeResult): string {
  // 137/152: killed by the CPU-time limit (SIGKILL/SIGXCPU), like the wall-clock limit.
  const killed = result.timedOut || result.exitCode === 137 || result.exitCode === 152;
  const lines = [killed ? `Stopped: over the time limit (${Math.round(result.ms / 1000)} s). Make the code faster or the job smaller.` : `Exit code ${result.exitCode} (${(result.ms / 1000).toFixed(1)} s).`];
  const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);
  if (result.stdout.trim()) lines.push("stdout:", tail(result.stdout.trimEnd(), OUTPUT_CHARS));
  if (result.stderr.trim()) lines.push("stderr:", tail(result.stderr.trimEnd(), 3000));
  if (result.files.length) lines.push(`Saved (posted after your reply): ${result.files.map((f) => f.name).join(", ")}`);
  return lines.join("\n");
}
