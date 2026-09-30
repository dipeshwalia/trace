# Trace

A small agent harness in TypeScript on Bun. It talks to models through OpenRouter.

## Setup

```sh
bun install
export TRACE_API_KEY=...   # an OpenRouter key; OPENROUTER_API_KEY also works
```

Set `TRACE_MODEL` to use a model other than the default in `trace/provider.ts`.

## Demo

```sh
bun demos/1-dice.ts [basic | bad-args | parallel | turn-limit]
```

With no argument, it lists the scenarios and asks which one to run.

## Layout

- `trace/provider.ts`: the only code that talks to OpenRouter.
- `trace/loop.ts`: the agent loop. It asks the model, runs tools, and feeds results back.
- `trace/logger.ts`: prints loop events with colors, a spinner, and usage and cost.
- `demos/`: runnable examples.

## Docs

- [How runLoop works](docs/runloop.svg): the turn cycle, `step()`, `execute()`, and the events the loop emits.

![How runLoop works](docs/runloop.svg)
