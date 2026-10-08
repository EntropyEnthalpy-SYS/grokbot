/**
 * Live check of group notes with real Grok (run on the server): "記住…" saves a note
 * through the remember tool, and a fresh strict-mode question uses it. Cleans up after itself.
 * Usage: node scripts/probe-memory.ts
 */
import { createApp } from "../src/app.ts";
import { assistantText } from "../src/grok/grok.ts";
import { loadConfig, loadDotEnv } from "../src/config.ts";

loadDotEnv();
const app = createApp(loadConfig());
const chatId = -999000111; // a fake chat: nothing is posted
const ask = async (key: string, text: string) => {
  app.speakers.set(key, { userId: 1, userName: "probe" });
  const tools: string[] = [];
  const reply = await app.sessions.run(key, { text }, { onTool: (name) => tools.push(name) });
  app.speakers.delete(key);
  app.sessions.reset(key);
  return `tools [${tools.join(", ")}] → ${assistantText(reply).replace(/\s+/g, " ").slice(0, 120)}`;
};
console.log("1.", await ask(`tg:${chatId}:q1`, "grok, 記住：小明吃素，而且對花生過敏"));
console.log("   notes:", JSON.stringify(app.memory.list(chatId).map((f) => f.text)));
console.log("2.", await ask(`tg:${chatId}:q2`, "週末聚餐想點宮保雞丁和花生湯圓，小明可以吃嗎？一句話回答"));
console.log("   removed", app.memory.forgetChat(chatId), "note(s)");
app.db.close();
