import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidateUrls, downloadBilibili } from "../src/media/bilibili.ts";

const COSOV = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/v.m4s?deadline=1&upsig=x";

test("CDN candidates: known-good hosts first, original last, query kept", () => {
  assert.deepEqual(candidateUrls(COSOV), [
    "https://upos-sz-upcdnbda2.bilivideo.com/upgcxcode/1/v.m4s?deadline=1&upsig=x",
    "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/v.m4s?deadline=1&upsig=x",
    COSOV,
  ]);
  const akam = "https://upos-hz-mirrorakam.akamaized.net/a.m4s?x=1";
  assert.equal(candidateUrls(akam)[0], akam, "an already-good host is tried as is first");
});

test("downloads each stream from the first host that answers, through the tunnel only for metadata, then merges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bili-"));
  // Real media so ffmpeg can merge: a video-only and an audio-only file.
  const video = join(dir, "src-v.mp4");
  const audio = join(dir, "src-a.m4a");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-c:v", "libx264", video]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac", audio]);
  const meta = {
    duration: 2,
    requested_formats: [
      { url: COSOV, ext: "mp4", vcodec: "avc1", width: 320, height: 240, filesize: 1000, http_headers: { Referer: "https://www.bilibili.com/" } },
      { url: "https://upos-hz-mirrorakam.akamaized.net/a.m4s", ext: "m4a", vcodec: "none", filesize: 1000, http_headers: {} },
    ],
  };
  const ytdlp = join(dir, "yt-dlp");
  const log = join(dir, "args.log");
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(ytdlp, `#!/bin/sh\necho "$*" >> "${log}"\ncat "${join(dir, "meta.json")}"\n`);
  chmodSync(ytdlp, 0o755);

  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const host = new URL(url).hostname;
    const range = new Headers(init?.headers).get("range");
    requests.push(`${host}${range ? " probe" : ""}`);
    if (host === "upos-sz-upcdnbda2.bilivideo.com" && url.includes("v.m4s")) return new Response("forbidden", { status: 403 });
    const file = url.includes("v.m4s") ? video : audio;
    return new Response(range ? "x" : readFileSync(file), { status: range ? 206 : 200 });
  }) as typeof fetch;

  const out = await downloadBilibili("https://www.bilibili.com/video/BV1", {
    ytdlp,
    proxy: "socks5://127.0.0.1:1080",
    dir: join(dir, "work"),
    maxBytes: 10_000_000,
    fetchImpl,
  });
  assert.match(readFileSync(log, "utf8"), /^--proxy socks5:\/\/127\.0\.0\.1:1080 -j /);
  assert.deepEqual(requests, [
    "upos-sz-upcdnbda2.bilivideo.com probe",
    "upos-hz-mirrorakam.akamaized.net probe",
    "upos-hz-mirrorakam.akamaized.net",
    "upos-hz-mirrorakam.akamaized.net probe",
    "upos-hz-mirrorakam.akamaized.net",
  ]);
  assert.equal(out.path, join(dir, "work", "bilibili.mp4"));
  assert.deepEqual({ w: out.width, h: out.height, d: out.duration }, { w: 320, h: 240, d: 2 });
  assert.ok(out.size > 1000);
  assert.equal(existsSync(join(dir, "work", "part0.mp4")), false, "parts removed after merging");
  const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out.path], { encoding: "utf8" });
  assert.deepEqual(streams.trim().split("\n").sort(), ["audio", "video"]);
});

test("refuses videos over the upload limit before downloading anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bili-"));
  const ytdlp = join(dir, "yt-dlp");
  writeFileSync(ytdlp, `#!/bin/sh\necho '${JSON.stringify({ requested_formats: [{ url: COSOV, filesize: 3_000_000_000 }] })}'\n`);
  chmodSync(ytdlp, 0o755);
  let fetched = false;
  await assert.rejects(
    downloadBilibili("https://www.bilibili.com/video/BV1", { ytdlp, dir, maxBytes: 2_000_000_000, fetchImpl: (async () => ((fetched = true), new Response(""))) as typeof fetch }),
    /over the upload limit/,
  );
  assert.equal(fetched, false);
});
