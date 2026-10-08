/**
 * Live check of the provider chain (run on the server): Grok answers through the
 * chain (one-shot and agent turn), and the ChatGPT sign-in starts (gets a real
 * OpenAI sign-in link), then is cancelled. Changes nothing.
 * Usage: node scripts/probe-providers.ts
 */
import { createApp } from "../src/app.ts";
import { assistantText } from "../src/grok/grok.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";

loadDotEnv();
const app = createApp(loadConfig());
const { grok } = app;
console.log("chain:", grok.chain.join(" → "), "| signed in:", (await grok.targets()).map((t) => `${t.provider}/${t.model.id}`).join(", "));
console.log("ask:", await grok.ask("Answer in at most 5 words.", "What is 2+3?"));
const key = "tg:-999000222:probe";
const reply = await app.sessions.run(key, { text: "Say hi in Traditional Chinese, 3 words max." });
app.sessions.reset(key);
console.log("agent turn:", assistantText(reply), "| stats:", JSON.stringify([...grok.stats]));

const abort = new AbortController();
const started = Date.now();
await grok
  .loginProvider(
    "openai",
    {
      onUrl: (url) => {
        const u = new URL(url);
        console.log(`ChatGPT sign-in link: ${u.host}${u.pathname} (redirect ${u.searchParams.get("redirect_uri")}) after ${Date.now() - started} ms`);
        setTimeout(() => abort.abort(), 500);
      },
      onPaste: (_m, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")))),
    },
    abort.signal,
  )
  .then(() => console.log("unexpected: login finished"))
  .catch((error) => console.log("sign-in cancelled as planned:", (error as Error).message));
console.log("openai signed in:", await grok.signedIn("openai"));

// Claude: the bot picks the copy-code login and gets a real sign-in link; cancelled before any code is needed.
const claudeAbort = new AbortController();
await grok
  .loginProvider(
    "anthropic",
    {
      onUrl: (url, instructions) => {
        const u = new URL(url);
        console.log(`Claude sign-in link: ${u.host}${u.pathname} (redirect ${u.searchParams.get("redirect_uri")}) — ${instructions}`);
        setTimeout(() => claudeAbort.abort(), 500);
      },
      onPaste: (_m, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")))),
    },
    claudeAbort.signal,
  )
  .then(() => console.log("unexpected: login finished"))
  .catch((error) => console.log("Claude sign-in cancelled as planned:", (error as Error).message));
console.log("anthropic signed in:", await grok.signedIn("anthropic"));
app.db.close();
