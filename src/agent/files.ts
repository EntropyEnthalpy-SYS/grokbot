import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { newDocx } from "../media/edit.ts";

/**
 * send_file: the AI hands the user a file ("做成 markdown 文件", a config, a script, a CSV) instead of
 * pasting it into the chat. Files made during an answer are posted right after it, like images.
 */

const FILES_PER_TURN = 3;
const MAX_FILE_CHARS = 200_000;
/** Text formats written as is; .docx is built from the text (paragraphs separated by blank lines). */
const TEXT_EXTENSIONS = new Set([
  "md", "txt", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "xml", "html", "css", "srt", "vtt", "log",
  "sh", "bash", "py", "js", "ts", "mjs", "go", "rs", "java", "kt", "c", "h", "cpp", "rb", "php", "sql", "ps1", "bat",
]);

export interface FileTurn {
  readonly key: string;
  readonly files: { name: string; data: Buffer }[];
}

const FileParams = Type.Object({
  name: Type.String({ description: "File name with extension, e.g. iplc-ss.md, config.yaml, data.csv, report.docx" }),
  content: Type.String({ description: "The complete file content (for .docx: plain text, paragraphs separated by blank lines)." }),
});

type FileToolResult = Awaited<ReturnType<AgentTool<typeof FileParams, undefined>["execute"]>>;
const result = (message: string, isError = false): FileToolResult => ({ content: [{ type: "text", text: message }], details: undefined, isError });

/** "../My Notes.md" → "My Notes.md"; unknown or missing extensions become .txt. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim().slice(0, 80) || "file";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  return ext === "docx" || TEXT_EXTENSIONS.has(ext) ? base : `${base.replace(/\.$/, "")}.txt`;
}

export class FileDesk {
  readonly #turns = new Map<string, FileTurn>();

  /** Call when an answer starts (turns of one chat never overlap). */
  begin(key: string): FileTurn {
    const turn: FileTurn = { key, files: [] };
    this.#turns.set(key, turn);
    return turn;
  }

  /** Call when the answer is done; returns the files to post. */
  end(turn: FileTurn): { name: string; data: Buffer }[] {
    if (this.#turns.get(turn.key) === turn) this.#turns.delete(turn.key);
    return turn.files;
  }

  tool(key: string): AgentTool<typeof FileParams, undefined> {
    return {
      name: "send_file",
      label: "Making a file",
      description:
        "Send the user a file: Markdown, text, code, a config, CSV/JSON, or a Word document (.docx). Use it when they ask for a file " +
        "or a download, or to save something long (a config, a script, a full document). The file is posted right after your reply: " +
        "don't paste its content into the reply too, just say in a line what it contains. Write the content exactly as it should be " +
        "saved: real ``` code fences, never backslash-escaped.",
      parameters: FileParams,
      execute: async (_id, { name, content }) => {
        const turn = this.#turns.get(key);
        if (!turn) return result("Files can't be sent here.", true);
        if (turn.files.length >= FILES_PER_TURN) return result(`At most ${FILES_PER_TURN} files per answer.`, true);
        if (!content.trim()) return result("The file would be empty.", true);
        if (content.length > MAX_FILE_CHARS) return result(`That's longer than ${MAX_FILE_CHARS} characters; split it.`, true);
        const file = safeFileName(name);
        // Markdown copied from a chat answer often has its fences escaped (\`\`\`) to survive the chat; files want real ones.
        const text = /\.(md|markdown|txt)$/i.test(file) ? content.replace(/\\`/g, "`") : content;
        const data = file.toLowerCase().endsWith(".docx")
          ? newDocx(text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean))
          : Buffer.from(text, "utf8");
        turn.files.push({ name: file, data });
        return result(`${file} will be sent right after your reply.`);
      },
    };
  }
}
