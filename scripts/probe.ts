/**
 * Check what this Grok login can do: plain chat and hosted web/X search on both
 * routes, plus the SuperGrok quota. Does not change any settings.
 * Usage: npm run probe
 */
import { createApp } from "../src/app.ts";
import { loadDotEnv } from "../src/config.ts";
import { errorMessage, ROUTES } from "../src/grok/grok.ts";

loadDotEnv();
const { grok, db } = createApp({
  dataDir: process.env.DATA_DIR?.trim() || "./data",
  defaultModel: process.env.GROK_MODEL?.trim() || "grok-4.7",
});

if (!(await grok.isLoggedIn())) {
  console.log("Not logged in. Run: npm run login");
  process.exit(1);
}
console.log(`model ${grok.modelId}, current route ${grok.route}`);
for (const route of ROUTES) {
  const chat = await grok.probe(route);
  console.log(`${chat.ok ? "OK  " : "FAIL"} chat   ${route}: ${chat.detail}`);
  if (!chat.ok) continue;
  const search = await grok.probe(route, { search: true });
  console.log(
    `${search.ok ? "OK  " : "FAIL"} search ${route}: ${search.detail} (search tool events seen: ${search.usedSearch ? "yes" : "no"})`,
  );
}
try {
  console.log("quota:", await grok.quota());
} catch (error) {
  console.log("quota: unavailable -", errorMessage(error));
}
db.close();
