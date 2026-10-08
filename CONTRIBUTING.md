# Contributing

Issues and pull requests are welcome.

## Setup

```bash
npm install
cp .env.example .env    # BOT_TOKEN and OWNER_ID of a test bot
npm start
```

Node 24 runs the TypeScript directly; there is no build step. `ffmpeg` is needed for the media tests.

## Before you open a pull request

```bash
npm run check           # tsc --noEmit + all tests
```

- Add or update tests for behavior you change (`test/`, node:test). Tests should fail without your change.
- New commands need a line in `src/telegram/guide.ts`; a test enforces it.
- Keep secrets, chat ids and server names out of commits.
- Scripts in `scripts/` talk to real services; don't make tests depend on them.
