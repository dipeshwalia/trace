# Trace

A small agent harness in TypeScript on Bun. It talks to models through OpenRouter.

## Setup

```sh
bun install
export TRACE_API_KEY=...   # an OpenRouter key; OPENROUTER_API_KEY also works
```

Set `TRACE_MODEL` to use a model other than the default in `trace/provider.ts`.

## Demos

```sh
bun demos/1-dice.ts [basic | bad-args | parallel | turn-limit]
bun demos/2-build.ts [fib | delete-home | delete-folder | escape]
bun demos/3-context.ts [compact | remember | skill]
```

With no argument, each demo lists its scenarios and asks which one to run.

`2-build.ts` gives the agent files and a shell, confined to a fresh folder
under the system temp directory; the path is printed as `workdir:`. To keep
the files somewhere easy to find, set `TRACE_WORKDIR`:

```sh
TRACE_WORKDIR=./scratch bun demos/2-build.ts fib
bun scratch/fib.ts
```

`scratch/` is ignored by git.

## Layout

- `trace/provider.ts`: the only code that talks to OpenRouter.
- `trace/loop.ts`: the agent loop. It asks the model, runs tools, and feeds results back.
- `trace/logger.ts`: prints loop events with colors, a spinner, and usage and cost.
- `trace/tools.ts`: the core tools (files, edits, shell, search), confined to a working directory.
- `trace/security.ts`: the policy that blocks dangerous tool calls.
- `trace/context.ts`: compacts old messages into a summary when history goes over a token budget.
- `trace/memory.ts`: builds the system prompt and keeps project notes in `TRACE.md`.
- `trace/skills.ts`: finds skills in `skills/<name>/SKILL.md` and gives the model a `use_skill` tool.
- `demos/`: runnable examples.

## Docs

- [How a Trace run works, end to end](docs/end-to-end.svg): setup in a demo, the `runLoop` cycle with compaction and the policy check, the observers, how a run ends, and where state lives.

![How a Trace run works, end to end](docs/end-to-end.svg)

- [How runLoop works](docs/runloop.svg): the turn cycle, `step()`, `execute()`, and the events the loop emits.

![How runLoop works](docs/runloop.svg)

- [How Trace checks a tool call](docs/tool-guards.svg): `Policy.check`, the `resolve()` path guard, the bash sandbox, and the six core tools.

![How Trace checks a tool call](docs/tool-guards.svg)

- [How memory and skills reach the model](docs/memory-skills.svg): `remember()` and `TRACE.md`, the parts of `buildSystemPrompt()`, the skill catalog, and how `use_skill` loads a skill during a run.

![How memory and skills reach the model](docs/memory-skills.svg)
