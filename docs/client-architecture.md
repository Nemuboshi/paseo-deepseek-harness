# Client architecture

The client part runs inside the Paseo app: desktop, web, and the native mobile
apps. The entry point is `index.client.tsx`.

## Limits

- Client code must not use Node.js or DOM APIs.
- Client code must not read files or the network.
- Client code must render on React Native and React Native Web.
- All data comes from the server part through the plugin RPC.

## Settings screen

`index.client.tsx` adds one settings screen with the id `dsh`. The title is
`DeepSeek Harness`. The fields come from `shared/settings.ts`:

| Field | Use |
|---|---|
| `executable` | Path to `dsh`, or blank for detection |
| `profile` | DSH profile name, or blank for `paseo` |

The screen also shows the **Subagent models** section from
`client/subagent-settings.tsx`. The user can search models, select single
models, select all, clear the list, or disable the section. The plugin saves
the choice in the DSH profile.

The screen sends changes through the server handlers
`subagent.settings.read` and `subagent.settings.save`. Both always take a
revision. A stale revision is rejected, so two open screens cannot overwrite
each other.

Changes apply to new sessions. The screen does not restart a running session.

## Timeline cards

The plugin adds three Paseo timeline card renderers. The contract lives in
`shared/timeline-cards.ts`. The card kind strings and the version number are
part of the contract. The renderer for a card kind must accept the version it
was registered with.

| Card | Data | Show |
|---|---|---|
| `plan-mode` | `{ active }` | A short line with the new plan-mode state |
| `permission-preset` | `{ preset }` | A short line with the new permission preset |
| `goal` | `{ operation, objective?, round?, maxRounds?, reason? }` | A short line with the goal change |
| `subagent-run` | `{ childSessionId, description?, state }` | A short line per subagent, running or finished |

The cards use `PLUGIN_ID` from the same file. The server emits a card only when
the host offers the `timeline.plugin` capability. Without that capability the
plugin sends no cards and no notice.

## Provider presentation

The provider name, label, icon and capabilities come from the server
registration in `server/provider.ts`. The client does not set them.

Tool cards, plan cards and todo lists are Paseo built-in item types. The plugin
only sends the data. The client does not render them.

## Tests

`server/client-icons.test.ts` checks that every icon the server refers to
exists in `client/`. `server/timeline-cards.test.ts` checks the card schemas
against the server data.