# Contributing to Puck

`AGENTS.md` holds the working notes for this repo, and the README's Develop section lists the commands.

## Checks

```bash
npm run typecheck && npm run lint && npm test
```

Lint stays at zero problems.
`npm run test:e2e` boots the real app and smoke-checks the UI; it needs a desktop session.

## Running the app for tests and checks

Use the isolated launch for any automated test or live check:

```bash
npm run start:isolated -- -- --remote-debugging-port=9222
```

It keeps all app data in a throwaway folder (under the OS temp dir, or `PUCK_ISOLATED_DIR`), uses Electron's mock keychain so macOS is never asked, and opens the window without taking focus.
`npm start` is for using Puck yourself: it reads and writes your real data folder and Keychain.

Never replace `HOME` to isolate Puck.
macOS then cannot find a keychain and shows a "Reset To Defaults" dialog on the desktop.
