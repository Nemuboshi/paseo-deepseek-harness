# Paseo plugin for DeepSeek Harness

This plugin connects the local DeepSeek Harness (`dsh`) to Paseo. It registers a
direct provider, so Paseo talks to `dsh` natively. The plugin does not use a
generic ACP adapter.

Provider ID: `dsh-pi`. Plugin ID: `paseo-deepseek-harness`.

## Requirements

- Paseo 0.11.0 or newer.
- `dsh` 0.2.x on the same machine as the Paseo daemon.
- Node.js 24 on the daemon host. Paseo builds a source install with npm, which
  ships with Node.
- A configured model route in the DSH profile. The plugin does not store API
  keys.

The plugin version follows the `dsh` line. See [compatibility](docs/compatibility.md).

## Install

In Paseo, open **Settings → Plugins → Install Plugin**. Paste this Git URL:

```
https://github.com/Nemuboshi/paseo-deepseek-harness
```

You can also use the CLI:

```bash
paseo plugin install https://github.com/Nemuboshi/paseo-deepseek-harness
```

Then open the plugin settings and set the `dsh` executable and profile if the
defaults do not match your machine.

## Use

1. Create a conversation with the **DeepSeek Harness** provider.
2. Select a model and a preset. The plugin reads both from the DSH profile.
3. Send a message.

Paseo shows these items while the agent works:

- Assistant text and reasoning, streamed as they arrive.
- A tool card for each tool call. The card shows the command, file, search or
  plan content.
- Approval and question cards. Paseo answers them through the native
  interaction channel.
- A plan card when the agent submits a plan through `exit_plan_mode`.
- One todo list for the session. It updates in place on each `todo_write`.
- Compaction, goal and mode-change notices.
- Token usage and context fill in the usage meter.

Paseo also imports and resumes existing `dsh` sessions. The plugin keeps the
native session ID, so both ends see one session.

### PTC preset

The `ptc` preset sends one `run_code` tool to the model. The real tool calls
run inside that script. The plugin shows each inner call as a normal tool card,
so `read`, `edit`, `pwsh` and `grep` keep their detail. The card for `run_code`
itself is hidden, because it only repeats the script text.

## Configuration

### Executable

The plugin finds `dsh` in this order:

1. The `PASEO_DSH_EXECUTABLE` environment variable.
2. The `dsh executable` field on the plugin settings screen.
3. `agents.providers.dsh-pi.command` in the Paseo configuration.
4. `dsh` on `PATH`.

### Profile

The plugin starts `dsh --profile paseo`. If that profile does not exist, the
plugin creates it once from the official `web` template. To use another
profile, set `PASEO_DSH_PROFILE` or the `dsh profile` field on the settings
screen. A profile you name must exist already. The plugin does not create it.

The bridge runs inside the profile and turns off the browser rows of the `web`
template. See [server architecture](docs/server-architecture.md).

### Subagent models

The settings screen has a **Subagent models** section. Use it to search models
by name or provider, and to select the models that subagents may use. The
plugin saves the selection in the DSH profile. On first start it selects all
available models. Later starts keep your choice.

Changes apply to new sessions. A running session keeps its own `dsh` process.

## Limitations

- The plugin does not modify the Paseo or `dsh` source code.
- The plugin runs `dsh` as a child process on the daemon host. That process
  runs without the Paseo sandbox.
- A native session has one owner. Release the session in another `dsh` client
  before you import or resume it in Paseo.
- The plugin makes no network requests. Model traffic goes through `dsh`.

## Development

```bash
pnpm install
pnpm run build
pnpm typecheck
pnpm test
```

Run `pnpm run verify:notes` and `pnpm run verify:docs` before you commit.
Read [development](docs/development.md) for the local plugin loop and the
release steps.

## Documentation

- [Documentation index](docs/README.md)
- [Server architecture](docs/server-architecture.md)
- [Client architecture](docs/client-architecture.md)
- [Compatibility](docs/compatibility.md)
- [Development](docs/development.md)

## License

MIT. See [LICENSE](LICENSE).

The plugin started from the Direct Provider plugin structure of
`Jecvay/paseo-dsh-direct`. Its license and copyright notice stay in
[LICENSE](LICENSE).