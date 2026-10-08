import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
