import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HealthMonitor, memoryCheck, socksCheck, ytdlpAgeCheck, type Check } from "../src/health.ts";

const MIN = 60_000;

function monitor(checks: Check[], heartbeatPath?: string) {
  const alerts: string[] = [];
  const health = new HealthMonitor({ checks, notify: async (text) => void alerts.push(text), heartbeatPath });
  return { health, alerts };
}

test("one failed check stays quiet; the second in a row alerts once; recovery is announced with the downtime", async () => {
  let up = true;
  const { health, alerts } = monitor([{ name: "ParseHub", run: async () => { if (!up) throw new Error("connection refused"); return "helper up"; } }]);
  const at = (minutes: number) => ({ now: minutes * 5 * MIN });
  await health.run(at(0));
  up = false;
  await health.run(at(1));
  assert.deepEqual(alerts, [], "a single blip is not reported");
  await health.run(at(2));
  await health.run(at(3));
  assert.deepEqual(alerts, ["🔴 ParseHub: connection refused"], "reported once, not every run");
  up = true;
  await health.run(at(4));
  assert.equal(alerts[1], "🟢 ParseHub recovered after 15 min: helper up");
  await health.run(at(5));
  assert.equal(alerts.length, 2);
});

test("a blip that recovers before the second failure never alerts", async () => {
  let fail = false;
  const { health, alerts } = monitor([{ name: "Grok", run: async () => { if (fail) throw new Error("HTTP 503"); return "ok"; } }]);
  fail = true;
  await health.run({ now: 0 });
  fail = false;
  await health.run({ now: 5 * MIN });
  fail = true;
  await health.run({ now: 10 * MIN });
  assert.deepEqual(alerts, []);
});

test("checks run on their own schedule unless forced; the heartbeat is written every run", async () => {
  const runs = { fast: 0, slow: 0 };
  const path = join(mkdtempSync(join(tmpdir(), "hb-")), "heartbeat.json");
  const { health } = monitor(
    [
      { name: "fast", everyMs: MIN, run: async () => String(++runs.fast) },
      { name: "slow", everyMs: 15 * MIN, run: async () => String(++runs.slow) },
    ],
    path,
  );
  for (let minute = 0; minute <= 15; minute++) await health.run({ now: minute * MIN });
  assert.deepEqual(runs, { fast: 16, slow: 2 });
  await health.run({ now: 15 * MIN + 1, force: true });
  assert.deepEqual(runs, { fast: 17, slow: 3 });
  const beat = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(beat.at, 15 * MIN + 1);
  assert.deepEqual(beat.checks.map((c: { name: string }) => c.name), ["fast", "slow"]);
});

test("a hanging check fails with a timeout instead of blocking the monitor", { timeout: 30_000 }, async () => {
  const { health } = monitor([{ name: "stuck", run: () => new Promise(() => undefined) }]);
  const [result] = await health.run({ now: 0 });
  assert.equal(result!.ok, false);
  assert.match(result!.detail, /no answer in 20 s/);
});

test("memory and yt-dlp thresholds", () => {
  assert.equal(memoryCheck(850 * 2 ** 20, 200 * 2 ** 20), "200 MB used");
  assert.throws(() => memoryCheck(850 * 2 ** 20, 900 * 2 ** 20), /high memory: 900 MB/);
  const now = Date.UTC(2026, 9, 9);
  assert.equal(ytdlpAgeCheck("2026.10.05\n", now), "yt-dlp 2026.10.05 (4 days old)");
  assert.doesNotThrow(() => ytdlpAgeCheck("2026.08.01.123456", now), "nightly suffix, 69 days");
  assert.doesNotThrow(() => ytdlpAgeCheck("2026.06.11", now), "120 days: still fine (releases can be ~3 months apart)");
  assert.throws(() => ytdlpAgeCheck("2026.05.01", now), /161 days old/);
  assert.throws(() => ytdlpAgeCheck("garbage", now), /unknown yt-dlp version/);
});

test("the tunnel check needs a real SOCKS5 answer, not just an open port", async () => {
  const serve = (reply: Buffer) =>
    new Promise<{ url: string; close: () => void }>((resolve) => {
      const server = createServer((socket) => socket.once("data", () => socket.end(reply)));
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        resolve({ url: `socks5://127.0.0.1:${port}`, close: () => server.close() });
      });
    });
  const good = await serve(Buffer.from([0x05, 0x00]));
  assert.match(await socksCheck(good.url), /SOCKS5 OK/);
  good.close();
  const wrong = await serve(Buffer.from("HTTP/1.1 400 Bad Request\r\n"));
  await assert.rejects(socksCheck(wrong.url), /unexpected SOCKS reply/);
  wrong.close();
  await assert.rejects(socksCheck("socks5://127.0.0.1:1"), /tunnel down/);
});

import { backupCheck, networkCheck, type ConnectTimer } from "../src/health.ts";

/** A fake network: each host answers with the given connect times; `null` means the connection failed. */
const network = (byHost: Record<string, (number | null)[]>): ConnectTimer => {
  const next = new Map<string, number>();
  return async (host) => {
    const i = next.get(host) ?? 0;
    next.set(host, i + 1);
    const ms = byHost[host]![i % byHost[host]!.length];
    if (ms === null || ms === undefined) throw new Error("timeout");
    return ms;
  };
};
const targets = [{ name: "xAI", host: "x" }, { name: "Telegram", host: "t" }];

test("network check: a clean network passes with medians; lost packets (slow or failed connects) fail it", async () => {
  const clean = await networkCheck(targets, { connectTime: network({ x: [3, 4, 5], t: [150, 160] }) });
  assert.equal(clean, "30 connects: 0 failed, 0 slow (median Telegram 150 ms, xAI 4 ms)");
  // One failure in 30 is a blip; two is a pattern.
  await networkCheck(targets, { connectTime: network({ x: [3, null, ...Array(13).fill(3)], t: [150] }) });
  await assert.rejects(networkCheck(targets, { connectTime: network({ x: [3, null, null, ...Array(12).fill(3)], t: [150] }) }), /unstable network: 30 connects: 2 failed/);
  // 1 s retries on more than 10 % of connects: what the old VPS showed (~10–20 %).
  await networkCheck(targets, { connectTime: network({ x: [1020, 1020, 1020, ...Array(12).fill(3)], t: [150] }) });
  await assert.rejects(networkCheck(targets, { connectTime: network({ x: [1020, 1020, 1020, 1020, ...Array(11).fill(3)], t: [150] }) }), /4 slow/);
});

test("backup check: missing, failed and stale backups are reported; a recent one passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const path = join(dir, "backup-status.json");
  const now = Date.UTC(2026, 9, 10, 12);
  await assert.rejects(backupCheck(path, undefined, now), /no off-server backup has run yet/);
  writeFileSync(path, JSON.stringify({ at: now - 2 * 3600_000, ok: false, detail: "sending failed: Connection refused" }));
  await assert.rejects(backupCheck(path, undefined, now), /last backup failed 2 h ago: sending failed: Connection refused/);
  writeFileSync(path, JSON.stringify({ at: now - 31 * 3600_000, ok: true, detail: "740 KB copied" }));
  await assert.rejects(backupCheck(path, undefined, now), /31 h old/);
  writeFileSync(path, JSON.stringify({ at: now - 5 * 3600_000, ok: true, detail: "740 KB copied" }));
  assert.equal(await backupCheck(path, undefined, now), "740 KB copied, 5 h ago");
});

import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

test("the backup receiver keeps SQLite files only, under a size limit, and the newest 14", () => {
  const home = mkdtempSync(join(tmpdir(), "recv-"));
  const receive = (input: Buffer) => spawnSync("bash", ["deploy/backup-receive.sh"], { input, env: { ...process.env, HOME: home }, encoding: "utf8" });
  const dbFile = join(home, "x.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
  db.close();
  const sqlite = readFileSync(dbFile);

  const stored = receive(sqlite);
  assert.equal(stored.status, 0);
  assert.match(stored.stdout, /^stored grokbot-\d{4}-\d{2}-\d{2}\.db, 1 kept/);
  assert.match(receive(Buffer.from("x".repeat(5000))).stdout, /refused: not a database/);
  assert.notEqual(receive(Buffer.from("x".repeat(5000))).status, 0);
  assert.match(receive(Buffer.from("tiny")).stdout, /refused: 4 bytes/);

  // 20 older copies: the newest 14 are kept.
  for (let day = 1; day <= 20; day++) execFileSync("cp", [dbFile, join(home, "backups", `grokbot-2020-01-${String(day).padStart(2, "0")}.db`)]);
  execFileSync("touch", ["-d", "2020-01-01", ...Array.from({ length: 20 }, (_, i) => join(home, "backups", `grokbot-2020-01-${String(i + 1).padStart(2, "0")}.db`))]);
  assert.match(receive(sqlite).stdout, /14 kept/);
  const kept = readdirSync(join(home, "backups")).filter((f) => f.endsWith(".db"));
  assert.equal(kept.length, 14);
  assert.ok(kept.some((f) => !f.startsWith("grokbot-2020")), "today's copy is among them");
  assert.deepEqual(readdirSync(join(home, "backups")).filter((f) => f.startsWith(".incoming")), [], "no partial files left");
});
