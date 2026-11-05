# DeepSeek Harness for Paseo

This plugin runs DeepSeek Harness (`dsh`) as a native Paseo provider. Paseo
desktop, web, iOS and Android clients control a local `dsh` agent. The plugin
skips the generic ACP adapter and uses the `dsh` APIs directly.

## Requirements

- Paseo 0.11.0 or newer.
- `dsh` 0.2.x on the daemon host.
- A model route in the DSH profile.

## Features

- Streams assistant text and reasoning as Paseo timeline items.
- Shows one tool card per tool call, with its arguments and output.
- Maps `exit_plan_mode` to a Paseo plan card.
- Maps `todo_write` to one Paseo todo list per session.
- Shows `ptc` preset work as normal tool cards. The `run_code` wrapper stays
  hidden.
- Sends approvals and user questions to Paseo native cards.
- Creates, resumes, cancels and closes sessions. Imports native `dsh` sessions
  with their original ID.
- Lists models and presets, and switches preset, permission preset and plan
  mode from Paseo.
- Adds `dsh` slash commands to the Paseo `/` menu.
- Reports token usage and context-window fill.
- Refuses idle runtime cleanup while `dsh` still has work.

## Processes

- The plugin runs in the Paseo daemon.
- For each session, the plugin starts one `dsh` child process.
- The plugin loads a bridge plugin into that child and talks to it over stdio.
- The plugin makes no network requests. `dsh` makes the model calls.

## Profile

- The plugin starts `dsh --profile paseo`. It creates that profile from the
  official `web` template when the profile is absent.
- `PASEO_DSH_PROFILE` or the `dsh profile` setting selects another existing
  profile.
- The bridge turns off the browser rows of the `web` template. `dsh` then
  starts without a web server or browser window.

## Settings

- `dsh executable`: overrides the detected executable.
- `dsh profile`: overrides the default profile.
- **Subagent models**: selects the models that subagents may use. The plugin
  saves this choice in the DSH profile.

Changes apply to new sessions only.