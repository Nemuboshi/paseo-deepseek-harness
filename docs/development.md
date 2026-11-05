# Development

## Setup

```bash
pnpm install
pnpm run build
```

`pnpm run build` does three things:

1. Bundles `server/dsh/bridge.ts` to `dist/dsh-bridge.mjs`.
2. Writes the bundle as a string into `server/generated-bridge.ts`.
3. Writes `server/generated-version.ts` from `package.json`.

Both generated files are ignored by git. Run the build before you install the
plugin from a fresh clone.

## Two package managers

Paseo runs the build steps from `paseo-plugin.json` with npm, so an installer
needs only Node.js. Every other command in this repository uses pnpm. Keep the
steps in `paseo-plugin.json` and `package.json` in sync when you add one.

Because the repository has no `package-lock.json`, the npm install step
resolves the ranges in `package.json`. The pnpm lockfile pins the development
toolchain only.

Paseo loads the plugin source from `client/`, `server/` and `shared/`. A
relative import outside those directories fails the plugin load.
`server/module-boundary.test.ts` checks this rule.

## Gates

| Command | Checks |
|---|---|
| `pnpm run build` | Bridge bundle and generated modules |
| `pnpm typecheck` | Shared, server, client and script projects |
| `pnpm test` | Unit and end-to-end suites |
| `pnpm run verify:notes` | `.agents/notes/` layout and format |
| `pnpm run verify:docs` | Relative links and source doc references |

A git hook runs the note and doc gates before each commit. Install it with
`pnpm install`; the hook comes from `lefthook.yml`. CI runs every gate on each
push and pull request.

## Local plugin loop

Install the working copy as a directory source:

```bash
paseo plugin install /absolute/path/to/paseo-deepseek-harness
```

Paseo loads the files in place. It does not copy them.

After an edit:

```bash
# Server or client code only
paseo plugin reload paseo-deepseek-harness

# An edit under server/dsh/ needs a new bundle first
npm run build && paseo plugin reload paseo-deepseek-harness
```

`plugin reload` stops the plugin and starts it again. A running `dsh` session
stops with it. Reload while sessions are idle.

Read the plugin output when a load fails:

```bash
paseo plugin logs paseo-deepseek-harness
```

## Test layout

| Suite | Covers |
|---|---|
| `server/provider.test.ts` | Provider registration, dispatch, sessions, configuration |
| `server/timeline.test.ts` | Event and stream projection to Paseo items |
| `server/tool-detail.test.ts` | Tool name to card detail, and output merge |
| `server/dsh/service.test.ts` | Bridge RPC methods and host events |
| `server/dsh-profile.test.ts` | Profile, patch, row audit and handshake |
| `server/dsh-spawn.test.ts` | Command and executable resolution |
| `server/bridge-client.test.ts` | JSONL line parsing |
| `server/e2e-interaction.test.ts` | Approvals, questions and turns against a fake `dsh` |
| `scripts/*.test.ts` | Repository gates and the maintainer scripts |

Tests use `node:test` through `tsx`. A test that needs a process uses a local
fake, not a real `dsh`.

Some suites start small shell scripts. On Windows those suites can fail,
because the fake executables are POSIX scripts. Treat such a failure as an
environment limit and run the suite on Linux CI before a release.

## Release

1. Update the version in `package.json`. Keep `major.minor` on the `dsh` line.
2. Add the entry at the top of `CHANGELOG.md`.
3. Run every gate.
4. Commit, then tag the commit `v<version>`.

This repository publishes nothing to npm. A release is a Git tag on main.
Paseo installs the plugin from the repository URL, so no package registry
is needed.

```bash
git tag v0.2.15
git push origin v0.2.15
```

## Code rules

- Match the existing module layout. See the module map in
  [server architecture](server-architecture.md).
- Put new code in the module that owns its work. Do not grow a hub again.
- Write one purpose per module. Keep a module under about 600 lines. When a
  file passes that size, look for a real seam before you split it.
- Comment the reason, not the code. One line is enough.
- Keep the module boundary. Client code stays free of Node and DOM APIs.
- Add a test for new behaviour that no current test covers.

## Where to write what

`docs/` states what is true now. It has no history and no reasons.

`.agents/notes/` holds decisions and the reasons behind them. The directory
name gives the state: `proposed/`, `implemented/`, `rejected/`, `archived/`.
Each state has kind subdirectories.

`.agents/skills/` holds repeatable agent procedures.

`AGENTS.md` holds the rules for agents that work in this repository.