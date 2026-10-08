/**
 * Log in with a Grok subscription from the terminal, then pick a working route.
 * Usage: npm run login
 */
import { createApp } from "../src/app.ts";
import { loadDotEnv } from "../src/config.ts";
import { errorMessage } from "../src/grok/grok.ts";

loadDotEnv();
const { grok, db } = createApp({
  dataDir: process.env.DATA_DIR?.trim() || "./data",
  defaultModel: process.env.GROK_MODEL?.trim() || "grok-4.7",
});

try {
  await grok.login((code) => {
    const expires = code.expiresInSeconds ? ` (expires in ${Math.round(code.expiresInSeconds / 60)} min)` : "";
    console.log(`\nOpen this URL in any browser and approve:\n  ${code.url}\nCode: ${code.userCode}${expires}\n`);
    console.log("Waiting for approval…");
  });
} catch (error) {
  console.error(`Login failed: ${errorMessage(error)}`);
  db.close();
  process.exit(1);
}
console.log("Logged in. Probing routes…");
for (const result of await grok.selectRoute()) {
  console.log(`${result.ok ? "OK  " : "FAIL"} ${result.route}: ${result.detail}`);
}
console.log(`Selected route: ${grok.route}`);
db.close();
