# Working on the puck workspace

This repository is one npm workspace with two packages.
Each package keeps its own package.json, tsconfig and scripts.

- `packages/desktop` - the Electron app. Read `packages/desktop/AGENTS.md` before you change it.
- `packages/swarm` - gimbal, imported unchanged from github.com/namikmesic/gimbal (see `NOTICE.md`).
  It is an ES module package (`"type": "module"`, NodeNext) with its own TypeScript and vitest versions, nested under its `node_modules`.
  Its `CLAUDE.md` is the imported gimbal file and describes gimbal at an older state; trust the source over it.

## Checks that must stay green

```bash
npm ci
npm run check    # typecheck, lint and tests for every package; this is what CI runs
```

Run one package's scripts with `npm run <script> --workspace packages/<name>`.
The Electron forge and webpack build runs from `packages/desktop`, not from the root.

## Architecture

The design specification decides how the two packages join.
Until it is reviewed, do not wire `packages/swarm` into the desktop runtime.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
