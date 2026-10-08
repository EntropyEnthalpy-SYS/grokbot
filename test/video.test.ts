import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDbAt } from "../src/db.ts";
import type { Transcription } from "../src/grok/grok.ts";
import { chooseSubtitle, DEFAULT_PROXY_SITES, formatVideo, frameTimes, streamOf, VideoReader } from "../src/media/video.ts";
import { formatTimestamp, joinTimed, parseVtt } from "../src/media/transcript.ts";
import { startsWithBotName } from "../src/telegram/groups.ts";

// Shape of the real YouTube auto-caption file fetched on the VPS (TEDx talk, en).
const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:19.560 --> 00:00:21.950 align:start position:0%
 
Hear<00:00:19.720><c> that?</c>

00:00:21.950 --> 00:00:21.960 align:start position:0%
Hear that?
 

00:00:21.960 --> 00:00:24.830 align:start position:0%
Hear that?
That's<00:00:22.960><c> nothing.</c>

00:00:24.830 --> 00:00:24.840 align:start position:0%
That's nothing.
 

00:00:52.100 --> 00:00:54.000 align:start position:0%
That's nothing.
I&#39;m &amp; done
`;

test("YouTube auto-captions: tags stripped, rolling repeats removed, entities decoded", () => {
  assert.deepEqual(parseVtt(AUTO_VTT), [
    { start: 19.56, text: "Hear that?" },
    { start: 21.96, text: "That's nothing." },
    { start: 52.1, text: "I'm & done" },
  ]);
});

test("a cue repeating several earlier lines adds only the new one", () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlpha\nBravo\n\n00:00:02.000 --> 00:00:03.000\nAlpha\nBravo\nCharlie\n";
  assert.deepEqual(parseVtt(vtt).map((t) => t.text), ["Alpha", "Bravo", "Charlie"]);
});

test("transcript gets a [m:ss] marker about every 30 seconds", () => {
  assert.equal(joinTimed(parseVtt(AUTO_VTT)), "[0:19] Hear that? That's nothing.\n[0:52] I'm & done");
  assert.equal(formatTimestamp(3725), "1:02:05");
  assert.equal(formatTimestamp(65), "1:05");
});

test("subtitle choice: preferred human subs, then original human subs, then original auto-captions; never machine translations", () => {
  const meta = { language: "en", subtitles: { "zh-TW": [], en: [], ar: [] }, automatic_captions: { "zh-Hant": [], en: [], "en-orig": [] } };
  assert.deepEqual(chooseSubtitle(meta, "zh-tw"), { lang: "zh-TW", auto: false });
  assert.deepEqual(chooseSubtitle(meta, "ja"), { lang: "en", auto: false });
  assert.deepEqual(chooseSubtitle({ ...meta, subtitles: {} }, "zh-tw"), { lang: "en-orig", auto: true }, "not the translated zh-Hant track");
  assert.equal(chooseSubtitle({ language: "en", subtitles: {}, automatic_captions: {} }, "en"), undefined);
});

test("only a voice/transcript that starts with the bot's name counts as a question", () => {
  assert.equal(startsWithBotName("Grok, what's the weather"), true);
  assert.equal(startsWithBotName("I told grok yesterday"), false);
});

function fakeTranscriber() {
  const calls: { name: string; size: number }[] = [];
  const transcribe = async (audio: Blob, name: string): Promise<Transcription> => {
    calls.push({ name, size: audio.size });
    return { text: "hello there", language: "en", duration: 3, words: [{ text: "hello", start: 0.2, end: 0.5 }, { text: "there", start: 31.5, end: 32 }] };
  };
  return { transcribe, calls };
}

test("uploaded video: real ffmpeg extracts speech audio and 4 frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-vt-"));
  const file = join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=8:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-shortest", "-c:v", "libx264", "-c:a", "aac", file]);
  const { transcribe, calls } = fakeTranscriber();
  const reader = new VideoReader({ db: openDbAt(":memory:"), transcribe });
  const info = await reader.watchFile(file, { frames: true, title: "my clip" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "speech.ogg");
  assert.ok(calls[0]!.size > 1000, "audio was extracted");
  assert.equal(info.transcriptSource, "speech");
  assert.equal(info.transcript, "[0:00] hello\n[0:31] there");
  assert.equal(info.frames.length, 4);
  assert.ok(Math.abs((info.durationSec ?? 0) - 8) < 0.5);
  const withUploader = await reader.watchFile(file, { title: "my clip", uploader: "uploaded by Amy" });
  assert.match(formatVideo(withUploader), /^Video: my clip\nuploaded by Amy · 0:08\n/);
  assert.match(formatVideo(info), /^Video: my clip\n0:08\n\nTranscript \(speech recognition\):\n\[0:00\] hello[\s\S]*\[4 frames from the video attached, in order\]$/);
});

test("video without sound: no transcript, no speech-to-text call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-vt-"));
  const file = join(dir, "silent.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=5", "-c:v", "libx264", file]);
  const { transcribe, calls } = fakeTranscriber();
  const info = await new VideoReader({ db: openDbAt(":memory:"), transcribe }).watchFile(file, { frames: true });
  assert.equal(calls.length, 0);
  assert.equal(info.transcriptSource, "none");
  assert.ok(info.frames.length >= 1);
  assert.match(formatVideo(info), /No transcript/);
});

/** A fake yt-dlp: prints metadata for -J and writes a subtitle file when asked. */
function fakeYtDlp(meta: object, vtt: string): { path: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-ytdlp-"));
  const log = join(dir, "calls.log");
  const path = join(dir, "yt-dlp");
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "sub.vtt"), vtt);
  writeFileSync(
    path,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *-J*) cat "${join(dir, "meta.json")}" ;;
  *--skip-download*)
    out=""; prev=""
    for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
    cp "${join(dir, "sub.vtt")}" "$(echo "$out" | sed 's/%(ext)s/en-orig.vtt/')" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

test("YouTube link: metadata + subtitles, no audio download or speech-to-text; cached afterwards", async () => {
  const meta = { title: "How to sound smart", uploader: "TEDx Talks", duration: 356, language: "en", subtitles: {}, automatic_captions: { "en-orig": [] } };
  const yt = fakeYtDlp(meta, AUTO_VTT);
  const { transcribe, calls } = fakeTranscriber();
  const reader = new VideoReader({ db: openDbAt(":memory:"), transcribe, ytdlp: yt.path });
  const url = "https://www.youtube.com/watch?v=8S0FDjFBj8o";
  const info = await reader.watchUrl(url);
  assert.equal(info.title, "How to sound smart");
  assert.equal(info.transcriptSource, "subtitles");
  assert.equal(info.transcript, "[0:19] Hear that? That's nothing.\n[0:52] I'm & done");
  assert.equal(calls.length, 0);
  const runs = lines(yt.log);
  assert.equal(runs.length, 2);
  assert.match(runs[1]!, /--write-auto-subs --sub-langs en-orig/);
  assert.match(runs[1]!, /-- https:\/\/www.youtube.com\/watch\?v=8S0FDjFBj8o$/, "URL passed after --, as one argument");

  await reader.watchUrl(url);
  assert.equal(lines(yt.log).length, 2, "second watch is served from cache");
});

test("seekable stream: first requested format's https URL with its headers; HLS/http refused", () => {
  assert.deepEqual(
    streamOf({ requested_formats: [{ url: "https://r.googlevideo.com/v", http_headers: { "User-Agent": "UA", Accept: "*/*" } }] }),
    { url: "https://r.googlevideo.com/v", headers: "User-Agent: UA\r\nAccept: */*\r\n" },
  );
  assert.deepEqual(streamOf({ url: "https://cdn/x.mp4" }), { url: "https://cdn/x.mp4", headers: "" });
  assert.equal(streamOf({ url: "http://cdn/x.mp4" }), undefined);
  assert.equal(streamOf({}), undefined);
});

test("frames for long videos are spread across the whole video", () => {
  assert.deepEqual(frameTimes(7200, 4), [900, 2700, 4500, 6300]);
  assert.deepEqual(frameTimes(8, 4), [1, 3, 5, 7]);
});

test("only video sites and X's video CDN can be watched", () => {
  assert.equal(VideoReader.canWatch("https://youtu.be/abc"), true);
  assert.equal(VideoReader.canWatch("https://video.twimg.com/ext_tw_video/1/pu/vid/a.mp4"), true);
  assert.equal(VideoReader.canWatch("https://evil.example/a.mp4"), false);
  assert.equal(VideoReader.canWatch("http://video.twimg.com/a.mp4"), false);
});

test("only Bilibili links use the proxy by default", () => {
  for (const url of ["https://www.bilibili.com/video/BV1", "https://bilibili.com/video/BV1", "https://b23.tv/abc", "https://upos-sz.bilivideo.com/x.mp4"]) {
    assert.equal(DEFAULT_PROXY_SITES.test(url), true, url);
  }
  for (const url of ["https://www.youtube.com/watch?v=1", "https://notbilibili.com/x", "https://www.tiktok.com/@a/video/1"]) {
    assert.equal(DEFAULT_PROXY_SITES.test(url), false, url);
  }
});

test("video links download as one MP4, capped at 1080p on the short side and the upload limit, with real size and duration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-dl-"));
  const sample = join(dir, "sample.mp4");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=360x640:rate=10", "-c:v", "libx264", sample]);
  const log = join(dir, "args.log");
  const ytdlp = join(dir, "yt-dlp");
  writeFileSync(ytdlp, `#!/bin/sh\necho "$*" > "${log}"\nprev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\ncp "${sample}" "$(echo "$out" | sed 's/%(ext)s/mp4/')"\n`);
  chmodSync(ytdlp, 0o755);
  const reader = new VideoReader({ db: openDbAt(":memory:"), transcribe: fakeTranscriber().transcribe, ytdlp });
  const out = join(dir, "out");
  execFileSync("mkdir", [out]);
  const file = await reader.downloadVideo("https://www.youtube.com/shorts/abc", out, 2000 * 1024 * 1024);
  assert.deepEqual(file && { w: file.width, h: file.height, d: file.duration, path: file.path }, { w: 360, h: 640, d: 3, path: join(out, "video.mp4") });
  const args = readFileSync(log, "utf8");
  assert.match(args, /-S res:1080 --merge-output-format mp4 --max-filesize 2000M/);
  assert.match(args, /-- https:\/\/www\.youtube\.com\/shorts\/abc\n$/);
});
