# dsh-crew

[![npm](https://img.shields.io/npm/v/@chendaleiq%2Fdsh-crew)](https://www.npmjs.com/package/@chendaleiq/dsh-crew)
[![license](https://img.shields.io/npm/l/@chendaleiq%2Fdsh-crew)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/chendaleiQ/dsh-crew)

A local-only roster of bots for DeepSeek Harness. Each bot has a name, a persona,
its own working directory and its own memory file. You hand one a task in a
sentence; the result — and anything waiting on you — lands in one inbox.

(The npm name is `@chendaleiq/dsh-crew`; the unscoped `dsh-crew` belongs to an
unrelated project.)

## What it is not

A deliberately smaller thing than a cloud agent platform:

| Want | Not wanted |
|---|---|
| Bots with their own folder, persona, memory | Cloud VMs that run while your Mac sleeps |
| One sentence to hand off work | Mobile apps, IM, Slack |
| One roster showing who is busy and who waits on you | Multi-tenant, SSO, enterprise controls |
| Reuses DSH's own approval flow | Payment rails |

## Install

```bash
dsh plugin --profile <profile> add @chendaleiq/dsh-crew
```

## The four things it does

1. **Roster** — `bot.json` per bot: name, role, persona, cwd, provider/model,
   agent preset, tool allowlist, memory file. A broken file shows up as broken
   instead of disappearing.
2. **Hand off** — opens a real DSH session in that bot's directory, injects the
   persona via `systemPrompt.section`, restricts tools via `tools.restrict` plus
   a `tools.guard` fallback, then records the outcome back onto the card.
3. **Inbox** — failures, empty turns, timeouts, goals waiting on a human, stopped
   goals. Rule: over-report rather than under-report.
4. **Goal mode** — give it an objective plus machine-checkable acceptance
   (`file:` / `run:` / `human:`). Each round gets a fresh session carrying only the
   goal, the acceptance state, the dead ends and the last round's conclusion.
   Progress is defined by acceptance checks passing, never by the model saying so.
   Three rounds without progress stops it. Only verification that passes counts as done.

Supporting pieces: memory compaction (archives to `memory.archive.md`, `[pin]`
entries never archived), routine recording (steps come from real `tool/call`
events, not from the model retelling), and a `crew` CLI.

## Where data lives

```
~/.dsh/crew/
  bots/<id>/bot.json          profile
  bots/<id>/memory.md         long-term memory (human-readable, editable)
  bots/<id>/memory.archive.md archived entries after compaction
  bots/<id>/routines/*.md     paths that worked, as drafts
  bots/<id>/goal.json         objective, acceptance, rounds, dead ends
  state.json                  runtime: which bot is busy with what
```

## Development

```bash
npm test          # 85 unit tests
npm run smoke     # boot a dev profile, create a bot, assign, fire a goal, check the inbox
```

See [docs/install.md](docs/install.md), [docs/host-api.md](docs/host-api.md).
