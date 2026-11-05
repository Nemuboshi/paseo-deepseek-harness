# Repository rules for agents

This repository is a Paseo plugin that runs DeepSeek Harness (`dsh`) as a
provider. Read this file and the matching page in `docs/` before you change
code.

## First steps

1. Read `README.md`.
2. Read the page in `docs/` that owns the area you will change.
3. Run `npm ci` and `npm run build` once.

## Layout

| Path | Content | Process |
|---|---|---|
| `index.server.ts` | Plugin server entry | Paseo daemon |
| `index.client.tsx` | Plugin client entry | Paseo app |
| `server/` | Provider, timeline, profile and RPC client | Paseo daemon |
| `server/dsh/` | Bridge that runs inside `dsh` | `dsh` child |
| `shared/` | RPC protocol, settings and card contract | Both |
| `client/` | Settings screen and timeline cards | Paseo app |
| `scripts/` | Repository gates and maintainer scripts | Node |
| `docs/` | Current facts for users and agents | - |
| `.agents/notes/` | Decisions and their reasons | - |

The module map in [server architecture](docs/server-architecture.md) names the
owner of each module. Use it to decide where new code goes.

## Hard rules

- Import only inside `client/`, `server/` and `shared/` from those directories.
  `server/module-boundary.test.ts` enforces this rule.
- Do not use Node.js or DOM APIs in `client/`. The client runs on mobile too.
- Never commit API keys, tokens, private paths or session logs.
- Do not grow `server/dsh/service.ts` with new concerns. Add a module.
- Keep a module under about 600 lines. Split on a real seam, not on a count.
- Write comments that state a reason. Delete comments that repeat the code.
- Do not change the module layout or the RPC protocol without a note in
  `.agents/notes/`.

## Gates

Run these before you commit:

```bash
npm run typecheck
npm test
npm run verify:notes
npm run verify:docs
```

A hook runs the note and doc gates on commit. Fix the cause. Do not bypass the
hook.

## Writing

- All user and agent text is English.
- Use short sentences. Write one instruction per sentence.
- Use active voice and the imperative for steps.
- Use these terms: plugin, provider, session, daemon, child process, bridge,
  tool, card, item.
- State facts, not history. Put reasons in `.agents/notes/`.

## Where to write

- A fact about current behaviour: `docs/`.
- A decision or a rejected option: `.agents/notes/`.
- A repeatable procedure: `.agents/skills/`.
- A change to the rules above: this file.

## Release

Read [development](docs/development.md#release). Keep `major.minor` on the
`dsh` line and record the version in `CHANGELOG.md`.

## Conflict

If a task conflicts with this file, stop and ask the user.