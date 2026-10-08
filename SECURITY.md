# Security

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security tab) instead of a public issue.

## How the bot handles secrets and access

- **Secrets** (bot token, API keys) come from the environment (`/etc/grokbot.env`, mode 640, root:grokbot). Provider logins are stored in the SQLite database in `DATA_DIR` (mode 700). Backups made from `/admin` leave logins and API keys out.
- **Access**: only the owner (`OWNER_ID`) can change settings, sign in, or open `/admin`. Other people need the owner's permission for private chats; groups must be enabled by the owner, and the bot leaves groups anyone else adds it to.
- **Link fetching** blocks private, loopback, link-local and CGNAT addresses and re-checks every redirect. The ParseHub helper only accepts known platform hosts and runs with outbound private addresses blocked.
- **Prompt injection**: fetched pages are wrapped and marked as untrusted data, and the model is told never to follow instructions in them. Tools that change state (notes, polls, images) are described as acting only on what a person in the chat asked for; this lowers the risk but can't rule it out, so notes are always visible (`/lm`) and removable.
- **Server**: the bot and its helpers run as an unprivileged user under systemd sandboxing. Owner actions that need root (restart, update) go through a fixed list in `deploy/grokbot-ops.sh` that never writes as root in the bot's folder.
