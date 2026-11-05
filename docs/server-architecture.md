# Server architecture

The plugin registers the Paseo Direct Provider `dsh-pi`. The provider label is
`DeepSeek Harness`. The app entry point is `index.server.ts`. The code is in
`server/`, and the cross-process contract is in `shared/`.

## Process boundary

Two processes take part:

- The **Paseo daemon** loads the plugin modules and runs the provider.
- One **`dsh` child process** runs each session. It also runs one discovery
  process for the model and preset catalog.

The daemon passes a bridge plugin to the child as source. The plugin writes it
to a temporary directory and loads it by absolute path. The bridge then reads
JSON-lines RPC requests on stdin and writes responses and notifications on
stdout.

The plugin does not change the Paseo or `dsh` source code.

## Profile

The default profile is `paseo`. The plugin creates it once from the official
`web` template:

```
dsh --profile paseo --from-default-profile web --dump-config
```

The command has a 60-second timeout. The plugin discards its output.

`PASEO_DSH_PROFILE` or the `dsh profile` setting selects another profile. A
named profile must exist. The plugin reports a missing one as an error.

## Bridge patch

The bridge loads as a Cordis plugin in the child. The plugin writes a
temporary patch for each process. The patch disables the browser rows of the
`web` template:

| Disabled row | Original work | Reason |
|---|---|---|
| `web-startup` | Starts the web app and provides `webStartup` | The bridge is the user interface |
| `webserver` | Binds an HTTP port | It needs `webStartup` |
| `web-runtime` | Serves the front end and opens a browser | It needs the first two rows |
| `connection` | Mounts the gateway on `/api` | It needs `webRuntime` |
| `api-remotes` | Sends approvals and questions to browser clients | The bridge must answer them. A browser request would wait forever |

The startup audit of `dsh` ignores disabled required rows. Thus `dsh` starts
without a TCP port and without a browser window. Browser-only rows such as
`file-upload` and `client-hmr` wait for a service that never arrives. `dsh`
prints one "entries did not activate" line. That line does not affect the
bridge.

## Session rules

- Each Paseo session owns one `dsh` child process. The child inherits the
  daemon environment plus the session environment from the host.
- `session.open.config.mcpServers` adds `@deepseek-ai/dsh-mcp-client` rows to
  the same patch.
- A session that Paseo marks as non-persistent writes its log to a temporary
  directory. The plugin deletes that directory when the bridge closes.
- Closing a session releases its child process.
- Subagent model settings use the native `dsh` settings service. The plugin
  does not change other user configuration.

## Executable choice

The plugin resolves `dsh` in this order:

1. `PASEO_DSH_EXECUTABLE`, if it is not blank. This value wins over the launch
   command, so the launch arguments are dropped.
2. The `dsh executable` field on the settings screen. Same rule.
3. `agents.providers.dsh-pi.command` from the Paseo configuration.
4. `dsh` on `PATH`.

`resolveDshLaunch` in `server/dsh-spawn.ts` applies this order.
`status()` and `connect` use the same resolution.

## Module map

The plugin loads modules from `client/`, `server/` and `shared/` only.
`server/module-boundary.test.ts` enforces that rule.

`server/dsh/` holds the code that runs inside the child and bundles into
`dist/dsh-bridge.mjs`. The rest of `server/` runs in the daemon.

| File | Work |
|---|---|
| `server/provider.ts` | Provider registration, status probe, connection wiring, input routing |
| `server/provider-sessions.ts` | Session open, prompt, command, cancel, close, permission reply, runtime-release check |
| `server/provider-listeners.ts` | Bridge events to provider events |
| `server/provider-config.ts` | Model and preset catalog, `session.config`, plan-mode switch |
| `server/provider-commands.ts` | Slash command list, refresh and broadcast |
| `server/provider-interaction.ts` | Approval and question mapping |
| `server/provider-support.ts` | Session state types, turn start and end, queue, prompt results |
| `server/timeline.ts` | `TimelineProjector`: DSH events and live chunks to Paseo items |
| `server/tool-detail.ts` | Tool name to Paseo tool card detail |
| `server/timeline-items.ts` | Item ids, timestamps, content text |
| `server/bridge-client.ts` | JSONL RPC client and bridge launch |
| `server/dsh-profile.ts` | Profile creation, patch, row audit, handshake |
| `server/dsh-spawn.ts` | `dsh` command resolution and child start |
| `server/dsh-config.ts`, `server/dsh-version.ts` | Settings merge and `dsh --version` probe |
| `server/dsh/bridge.ts` | Child entry point: stdin lines, RPC dispatch, exit |
| `server/dsh/service.ts` | RPC methods and host event stream |
| `server/dsh/service-params.ts` | RPC parameter checks and saved model fold |
| `server/dsh/subagent-settings.ts`, `server/dsh/runtime-safety.ts` | Subagent model settings, runtime-release rules, subagent run tracking |
| `shared/bridge-protocol.ts` | RPC methods, notifications, events, snapshots |

`server/dsh/service.ts` holds one `BridgeService` class of about 990 lines.
Split it only if a real seam appears.

## Event mapping

`TimelineProjector` turns durable `dsh` events and live stream frames into
Paseo items. Replay and live delivery use the same code.

| DSH input | Paseo item |
|---|---|
| `user/message` with a user source | `user_message` |
| `assistant/message` text block | `assistant_message` |
| `assistant/message` reasoning block | `reasoning` |
| `tool/call` and `tool/result` | `tool_call` with the mapped detail |
| `tool/ptc-dispatch-start` and `tool/ptc-dispatch` | `tool_call` with the inner tool detail |
| `tool/call` named `run_code` | no item. The PTC children carry the work |
| `exit_plan_mode` | `tool_call` with the `plan` detail |
| `todo/write` | one `todo` item with the id `dsh-todos` |
| `compaction/start` and `compaction/end` | one `compaction` item |
| `command/run` and `command/done` | `user_message` and a notice |
| `turn/end` with a failure or warning | `error` item or notice |
| `plan/mode`, `permission/preset`, `goal/change` | plugin card, if Paseo offers `timeline.plugin` |

Live `text-delta` and `reasoning-delta` chunks keep one item id per turn, step
and attempt. Paseo receives cumulative text for that id. The durable message
then settles the same id.

### Tool card details

The plugin maps these tool names to Paseo detail cards: `bash`, `pwsh`,
`read`, `read_image`, `write`, `edit`, `grep`, `glob`, `web_fetch`,
`exit_plan_mode`.

These tools get a plain-text card with one label line: `subagent`,
`list_agents`, `send_message`, `interrupt_agent`, `skill`, `todo_write`,
`job_output`, `job_list`, `working_directory`, `present`, `create_goal`,
`update_goal`, `get_goal`.

All other names, including MCP tools, keep the generic card with the raw
arguments. The plugin matches names exactly. It never guesses a card type from
part of a name.

### PTC preset

The `ptc` preset shows the model one tool, `run_code`, plus a generated SDK.
The inner tool calls then arrive as `tool/ptc-dispatch-start` and
`tool/ptc-dispatch`. The plugin uses `subCallId` as the Paseo `callId`, so an
approval for an inner call pairs with its card. The `run_code` stream, call and
result produce no card.

## Usage

The plugin reads the `tokenUsage` and `contextPressure` projections and sends
`session.usage` when either value changes. It sends nothing for zero values and
nothing for an unchanged fold. Context used prefers `projectedTokens`. If that
field is absent, the plugin uses `pressureTokens`.

## Idle runtime release

On Paseo 0.14, the host asks whether it can release an idle session runtime.
The plugin answers `canStop: false` while any of these checks finds work:
agents, inboxes, maintenance, background jobs, subagent completion delivery,
goals, reminders. After the host releases the runtime, the next message
resumes the same native session.

## Approvals and questions

The bridge takes `approval/request` and `user-questions/request` before the web
gateway sees them. It sends them to Paseo as native interaction requests. A tool
that Paseo preapproves is answered `allowed-once` without a card.

## Commands

The plugin lists `dsh` commands and user-invokable skills for the Paseo `/`
menu. A command wins over a skill with the same name. A command that leaves the
agent running counts as the prompt for the current turn.

## Tests

`npm test` runs the suites in `server/` and `scripts/`. The suites cover the
bridge handshake, event mapping, session lifecycle, approvals, usage and the
runtime-release check. The end-to-end suite uses a fake `dsh` process.