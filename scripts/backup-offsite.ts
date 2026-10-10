/**
 * Writes the nightly off-server backup: the database without logins, API keys, conversations,
 * the group log or cached pages. Prints the file's path. Run by deploy/grokbot-backup.sh as the
 * bot user, which then sends the file to the backup server and deletes it here.
 */
import { mkdirSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { backupWithoutSecrets } from "../src/ops.ts";

const dataDir = process.env.DATA_DIR ?? "/var/lib/grokbot";
const dir = `${dataDir}/backups`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = openDb(dataDir);
try {
  console.log(backupWithoutSecrets(db, dir, { withoutHistory: true }));
} finally {
  db.close();
}
