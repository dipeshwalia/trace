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
- `demos/`: runnable examples.

## Docs

- [How runLoop works](docs/runloop.svg): the turn cycle, `step()`, `execute()`, and the events the loop emits.

![How runLoop works](docs/runloop.svg)
