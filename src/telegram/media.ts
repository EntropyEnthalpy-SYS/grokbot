import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Grok, Transcription } from "../grok/grok.ts";
import { run } from "../media/run.ts";
import { formatVideo, type VideoInfo, type VideoReader } from "../media/video.ts";
import { DOCUMENT_MAX_BYTES, isReadableDocument, readDocument, type DocumentContent } from "../media/documents.ts";

/** Telegram's hosted Bot API lets bots download files up to 20 MB; a local Bot API server allows 2000 MB. */
export const CLOUD_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const LOCAL_DOWNLOAD_BYTES = 2000 * 1024 * 1024;
/** Voice notes longer than this are not transcribed automatically (they still are on request). */
export const AUTO_VOICE_MAX_SECONDS = 30 * 60;
/** Audio larger than this is compressed to small mono Opus before speech-to-text (keeps memory low). */
const RAW_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

export interface MediaContent {
  /** Text for Grok describing the media (transcript, video description); empty for photos. */
  text: string;
  images: ImageContent[];
}

type FileRef = { file_id: string; file_size?: number };

export function voiceOf(message: Message): (FileRef & { duration: number }) | undefined {
  return message.voice ?? message.audio;
}

/** A document the bot can read (PDF, Word, PowerPoint, text…), or a picture sent as a file. */
export function documentOf(message: Message): Message["document"] | undefined {
  const doc = message.document;
  if (!doc) return undefined;
  return isReadableDocument(doc.file_name, doc.mime_type) || /^image\/(jpeg|png|webp)$/.test(doc.mime_type ?? "") ? doc : undefined;
}

export function videoOf(message: Message): (FileRef & { duration: number }) | undefined {
  return message.video ?? message.video_note ?? message.animation;
}

export class TelegramMedia {
  readonly #api: Api;
  readonly #token: string;
  readonly #grok: Grok;
  readonly #video: VideoReader;

  readonly #apiRoot: string | undefined;
  readonly #ffmpeg: string;

  /** `apiRoot` set = local Bot API server: getFile returns a path on this machine. */
  constructor(options: { api: Api; token: string; grok: Grok; video: VideoReader; apiRoot?: string; ffmpeg?: string }) {
    this.#apiRoot = options.apiRoot;
    this.#ffmpeg = options.ffmpeg ?? "ffmpeg";
    this.#api = options.api;
    this.#token = options.token;
    this.#grok = options.grok;
    this.#video = options.video;
  }

  async transcribeVoice(message: Message): Promise<Transcription | undefined> {
    const voice = voiceOf(message);
    if (!voice) return undefined;
    return this.#withFile(voice, async (path, dir) => {
      let audio = path;
      let name = message.audio?.file_name ?? "voice.ogg";
      if ((await stat(path)).size > RAW_AUDIO_MAX_BYTES) {
        audio = join(dir, "speech.ogg");
        name = "speech.ogg";
        await run(this.#ffmpeg, ["-nostdin", "-loglevel", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", audio], {
          timeoutMs: 300_000,
        });
      }
      return this.#grok.transcribe(new Blob([await readFile(audio)]), name, {});
    });
  }

  async watchVideo(message: Message, options: { frames?: boolean; preferLanguage?: string } = {}): Promise<VideoInfo | undefined> {
    const video = videoOf(message);
    if (!video) return undefined;
    const from = message.from;
    const uploader = from ? `uploaded by ${[from.first_name, from.last_name].filter(Boolean).join(" ")}` : undefined;
    return this.#withFile(video, (path) => this.#video.watchFile(path, { frames: options.frames ?? true, title: message.caption, uploader }));
  }

  async photo(message: Message): Promise<ImageContent | undefined> {
    const photo = message.photo?.at(-1);
    if (!photo) return undefined;
    const data = (await this.#withFile(photo, (path) => readFile(path))).toString("base64");
    return { type: "image", data, mimeType: "image/jpeg" };
  }

  /** A document's text (and scanned pages as images); a picture sent as a file is returned as an image. */
  async document(message: Message): Promise<(DocumentContent & { name: string }) | undefined> {
    const doc = documentOf(message);
    if (!doc) return undefined;
    const name = doc.file_name ?? "document";
    if (doc.file_size !== undefined && doc.file_size > DOCUMENT_MAX_BYTES) {
      throw new Error(`That document is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`);
    }
    if (/^image\//.test(doc.mime_type ?? "")) {
      const data = (await this.#withFile(doc, (path) => readFile(path))).toString("base64");
      return { name, kind: "image file", text: "", images: [{ type: "image", data, mimeType: doc.mime_type! }], truncated: false };
    }
    // The file is deleted as soon as its text is read.
    const content = await this.#withFile(doc, (path, dir) => readDocument(path, { fileName: doc.file_name, mimeType: doc.mime_type, workDir: dir }));
    return { ...content, name };
  }

  /** Everything Grok needs to understand a message's media: photo, voice transcript, watched video, or document. */
  async content(message: Message): Promise<MediaContent | undefined> {
    if (documentOf(message)) {
      const doc = (await this.document(message))!;
      const header = `Document "${doc.name}" (${doc.kind}${doc.truncated ? ", long: the middle is omitted" : ""})`;
      return { text: doc.text ? `${header}:\n${doc.text}` : header, images: doc.images };
    }
    if (message.photo) {
      const image = await this.photo(message);
      return image ? { text: "", images: [image] } : undefined;
    }
    if (voiceOf(message)) {
      const result = await this.transcribeVoice(message);
      return { text: `Voice message transcript: ${result?.text || "(no speech)"}`, images: [] };
    }
    if (videoOf(message)) {
      const info = await this.watchVideo(message);
      return info ? { text: formatVideo(info), images: info.frames } : undefined;
    }
    return undefined;
  }

  /**
   * Run `use` with the file on local disk, never holding it in memory: the
   * local Bot API server's own copy, or a streamed download into a temp folder.
   * Both are deleted afterwards.
   */
  async #withFile<T>(file: FileRef, use: (path: string, dir: string) => Promise<T>): Promise<T> {
    const limit = this.#apiRoot ? LOCAL_DOWNLOAD_BYTES : CLOUD_DOWNLOAD_BYTES;
    if (file.file_size !== undefined && file.file_size > limit) {
      throw new Error(`That file is larger than the ${Math.round(limit / 1024 / 1024)} MB limit for bots.`);
    }
    const info = await this.#api.getFile(file.file_id);
    if (!info.file_path) throw new Error("Telegram did not return a file path.");
    const dir = await mkdtemp(join(tmpdir(), "grokbot-file-"));
    try {
      if (this.#apiRoot && isAbsolute(info.file_path)) {
        // The local Bot API server saved a copy on this VPS; keep it only as long as needed.
        try {
          return await use(info.file_path, dir);
        } finally {
          await unlink(info.file_path).catch(() => undefined);
        }
      }
      const root = this.#apiRoot ?? "https://api.telegram.org";
      const response = await fetch(`${root}/file/bot${this.#token}/${info.file_path}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Telegram file download failed (HTTP ${response.status}).`);
      const path = join(dir, "file");
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
      return await use(path, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
