# Compatibility

The plugin talks to two moving parts: Paseo and DeepSeek Harness. This page
states which versions work and how the version number is built.

## Version rule

The plugin version has three parts: `major.minor.patch`.

- `major.minor` follows the `dsh` line that the plugin supports. Plugin
  `0.2.x` supports `dsh` `0.2.x`.
- `patch` is the release number of the plugin itself. It does not follow `dsh`.

The plugin compares its own `major.minor` with the version of the local `dsh`.
On a mismatch it shows a warning in the session timeline. It does not block the
session. Only the `dsh` handshake can reject a session.

A plugin line stays on its own branch. Branch `main` follows the current `dsh`
line. An older line lives on `rel/<major.minor>`.

## Version floors

| Part | Floor | Reason |
|---|---|---|
| Paseo | `0.11.0` | Provider plugin API, provider name and icon |
| `dsh` | `0.2.0` | Bridge services and event names |

The floors go up only for a real incompatibility. A new Paseo or `dsh` feature
must degrade on older versions. Do not raise a floor for a cosmetic gain.

## Tested versions

The following versions passed the acceptance runs:

| Plugin | Paseo | dsh |
|---|---|---|
| `0.2.15` | `0.14.0` | `0.2.1-rc.5` |

The peer dependencies in `package.json` name the Paseo packages that the plugin
was built against.

## Paseo capabilities

The plugin asks for these capabilities and uses each one when the host offers
it:

- `prompt.message`, `prompt.command`, `prompt.image`, `prompt.steer`
- `session.list`, `session.configure`, `session.persistence`
- `session.can_stop_runtime`
- `permission`, `permission.tool_policy`
- `timeline.plugin`

Without `timeline.plugin` the plugin sends no cards. Without
`session.can_stop_runtime` the host does not ask about idle runtimes. All other
features need no negotiation.

## dsh profile

The plugin creates the default `paseo` profile once, from the `web` template of
the installed `dsh`. The profile keeps its own copies of the template rows.

After a `dsh` upgrade that changes the template, the profile can lack rows that
the bridge disables. The startup audit then fails with a message that names the
missing rows. Recreate the profile from the new template:

```bash
dsh --profile paseo --from-default-profile web --dump-config
```

A named profile is never created or changed by the plugin.

## Plugin updates

```bash
paseo plugin update paseo-deepseek-harness --check
paseo plugin update paseo-deepseek-harness --yes
```

A new session uses the new code. A running session keeps its current `dsh`
process until it closes.

## Session ownership

A native `dsh` session has one owner. Release the session in another `dsh`
client before you import or resume it in Paseo. A session that another client
still holds fails to open.

## Data kept in Paseo

- The native `dsh` session ID, in the session persistence data.
- The plugin timeline cards, with the plugin ID and card version.
- The settings for executable, profile and subagent models.

A plugin upgrade keeps all three. A downgrade keeps them only if the older
version accepts the same data shapes.