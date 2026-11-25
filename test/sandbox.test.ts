import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodeRunner, describeRun } from "../src/agent/sandbox.ts";

const runner = new CodeRunner({ venv: process.env.SANDBOX_PYTHON ?? "/opt/pysandbox", workRoot: mkdtempSync(join(tmpdir(), "sandbox-")), timeoutMs: 6000 });

test("run_code's box: reads its inputs and saves files, but has no network, no host files and a time limit", { skip: runner.available ? false : "bubblewrap or /opt/pysandbox not installed", timeout: 30_000 }, async () => {
  const data = await runner.run("import csv\nrows = list(csv.DictReader(open('sales.csv')))\nprint(sum(int(r['n']) for r in rows))\nopen('out/total.txt', 'w').write('42')", [
    { name: "sales.csv", data: Buffer.from("n\n10\n32\n") },
  ]);
  assert.equal(data.stdout.trim(), "42");
  assert.deepEqual(data.files.map((f) => [f.name, f.data.toString()]), [["total.txt", "42"]]);

  const net = await runner.run("import socket\nsocket.create_connection(('1.1.1.1', 80), timeout=2)");
  assert.notEqual(net.exitCode, 0, "no network");
  const host = await runner.run(`import os\nprint([p for p in ['/etc/passwd', '${process.cwd()}', '/root', '/home'] if os.path.exists(p)])`);
  assert.equal(host.stdout.trim(), "[]", "nothing of the host but system programs");

  const loop = await runner.run("while True: pass");
  assert.match(describeRun(loop), /over the time limit/);
});
