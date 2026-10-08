import type { Db } from "../db.ts";
import type { Grok } from "../grok/grok.ts";
import { languageName } from "../lang.ts";
import { formatVideo, type VideoInfo, type VideoReader } from "../media/video.ts";
import { linkKind } from "./detect.ts";
import { untrusted, type LinkReader } from "./reader.ts";

const CARD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Content cards report what a link says, with no opinion. Commentary happens
 * only when someone asks the bot about the link.
 */
const PAGE_SYSTEM = [
  "You extract the content of a link shared in a Telegram group chat.",
  "Report only what the source itself says. Do not comment, judge, speculate, or add your opinion or a takeaway.",
  "Output exactly this shape, nothing before or after:",
  "🔗 **<the source's title, translated if needed>**",
  "- <what it says>",
  "- <what it says>",
  "- <what it says>",
  "Rules: at most 3 bullets of one short sentence each; keep key names, numbers and dates; plain Markdown only; no tables;",
  "never add facts that are not in the source; if the source is unreadable, a login wall, or an error page, say so in one line instead.",
  "Long pages are trimmed and may contain a “[… characters omitted …]” marker: that is normal, summarize the text you have.",
].join("\n");

const VIDEO_SYSTEM = [
  "You extract the content of a video shared in a Telegram group chat, from its transcript, description and frames.",
  "Report only what the video says and shows. Do not comment, judge, or add your opinion or a takeaway.",
  "Output exactly this shape, nothing before or after:",
  "🎬 **<the video's title, translated if needed; if it has none, a short factual title describing it>**",
  "<channel or uploader> · <length>   (leave out any part that is unknown; drop the line if both are)",
  "- [m:ss] <what is said or shown at that point>",
  "- [m:ss] <what is said or shown>",
  "- [m:ss] <what is said or shown>",
  "Rules: at most 4 bullets of one short sentence each; take timestamps from the transcript markers;",
  "if there is no transcript, describe what the frames show and say the video has no speech or subtitles;",
  "keep key names and numbers; plain Markdown only; never add facts that are not in the material.",
].join("\n");

export interface LinkSummaryDeps {
  db: Db;
  grok: Grok;
  reader: LinkReader;
  video?: VideoReader;
}

/**
 * Content card for a web page or video link in the group language `lang`
 * (a code such as "zh-tw"). X posts use the X card instead.
 */
export async function summarizeLink(deps: LinkSummaryDeps, url: string, lang: string, signal?: AbortSignal): Promise<string> {
  const kind = linkKind(url);
  if (kind === "x") throw new Error("X posts are shown with the X card, not a text summary");
  const cacheKey = `${url}#${lang}`;
  const cached = deps.db
    .prepare("SELECT summary, fetched_at FROM link_cache WHERE url = ? AND summary IS NOT NULL")
    .get(cacheKey) as { summary: string; fetched_at: number } | undefined;
  if (cached && Date.now() - cached.fetched_at < CARD_TTL_MS) return cached.summary;

  const instruction = `Write in ${languageName(lang)}.`;
  let card: string;
  if (kind === "video") {
    card = await videoCard(deps, url, lang, instruction, signal);
  } else {
    const content = await deps.reader.read(url, signal);
    card = await deps.grok.ask(PAGE_SYSTEM, `${instruction}\n\n${untrusted(url, content.text)}`, { signal });
  }
  // Anything but a card ("couldn't read this…") is a failure: don't post it to the group or cache it.
  if (!/^\s*(🔗|🎬)/u.test(card)) throw new Error(`no content card: ${card.slice(0, 200)}`);

  deps.db
    .prepare(
      "INSERT INTO link_cache (url, summary, fetched_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(url) DO UPDATE SET summary = excluded.summary, fetched_at = excluded.fetched_at",
    )
    .run(cacheKey, card, Date.now());
  return card;
}

/** Neutral 🎬 card from an already-watched video (a link, or a file uploaded to Telegram). */
export async function videoCardFromInfo(grok: Grok, source: string, info: VideoInfo, lang: string, signal?: AbortSignal): Promise<string> {
  const card = await grok.ask(VIDEO_SYSTEM, `Write in ${languageName(lang)}.\n\n${untrusted(source, formatVideo(info))}`, {
    images: info.frames,
    signal,
  });
  if (!card.trimStart().startsWith("🎬")) throw new Error(`no video card: ${card.slice(0, 200)}`);
  return card;
}

/** Watch the video (transcript, or frames when it has no speech); fall back to its page and web search. */
async function videoCard(deps: LinkSummaryDeps, url: string, lang: string, instruction: string, signal?: AbortSignal): Promise<string> {
  if (deps.video) {
    try {
      const preferLanguage = lang === "off" ? undefined : lang;
      let info = await deps.video.watchUrl(url, { preferLanguage, signal });
      if (info.transcriptSource === "none") info = await deps.video.watchUrl(url, { preferLanguage, frames: true, signal });
      return await videoCardFromInfo(deps.grok, url, info, lang, signal);
    } catch (error) {
      console.warn(`watching ${url} failed, using web search: ${(error as Error).message}`);
    }
  }
  return deps.grok.ask(
    VIDEO_SYSTEM,
    [
      `The video itself could not be fetched. Report what it is and covers from its page, description, and coverage found with web search. ${instruction}`,
      "Use no timestamps, and make the last bullet say the video itself wasn't watched.",
      url,
    ].join("\n"),
    { search: true, signal },
  );
}
