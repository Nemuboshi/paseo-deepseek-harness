# Acceptance

Run this list before a release. An item counts as passed only with a recorded
result: a command output, a screenshot, or a session log.

## Automated

| Check | Command |
|---|---|
| Gates | `pnpm run build`, `pnpm typecheck`, `pnpm test`, `pnpm run verify:notes`, `pnpm run verify:docs` |
| Bridge handshake against a real `dsh` | `pnpm run smoke:bridge` |
| Paseo 0.14 host flow | `pnpm test` runs `scripts/paseo-014.e2e.test.ts` |

## Manual, with a real model

Do each item in a fresh Paseo conversation with the DeepSeek Harness provider.

1. Send a prompt. Text and reasoning stream during the turn.
2. Let the agent call a tool. The card shows the command, path or query, and
   the output.
3. Set the permission preset to a mode that asks. Approve one call and reject
   another. Both cards close.
4. Ask a question that makes the agent call `ask_user_question`. Answer from
   Paseo.
5. Switch to the `ptc` preset. The tool cards show the inner `read`, `edit` and
   `pwsh` calls. No `run_code` card appears.
6. Enter plan mode with `/plan`. The agent submits a plan. Paseo shows the plan
   card. Approve it, then repeat and choose "Keep planning".
7. Send a task with more than three steps. The todo list updates in place.
8. Run `/compact`. One compaction card goes from loading to completed.
9. Import a session that a `dsh` terminal client created. The session keeps
   its original ID, and its history appears in Paseo.
10. Stop a running turn, then send another message. The same session answers.
11. Open the usage meter. Input, cache, output and context values move.
12. Release an idle session runtime on Paseo 0.14. The next message resumes the
    same session.
13. Add an MCP server in the session configuration. Its tools appear and one
    call succeeds.

## Record

Add the result to `.agents/ops-log.md` when the run is part of a release. Name
the plugin, Paseo and `dsh` versions. Name each item that failed.