/**
 * Command line entry point, run as `bun run trace` or `bun trace/cli.ts`.
 *
 * Concept: the front door. With -p it runs one task headless and exits;
 * without it, it opens a prompt loop over one Harness, so every task in the
 * loop shares one history and one session file. --resume continues the
 * latest session in the working directory.
 *
 * Design rules: Bun and Node standard library only; flags are parsed with
 * node:util parseArgs; headless defaults to yolo and interactive to safe,
 * where each write asks for approval; a refused or unanswered approval
 * refuses; Ctrl-C during a run exits 130 and points at --resume, since every
 * message is already in the session log.
 */
import { parseArgs, styleText } from "node:util";
import { Harness } from "./harness.ts";
import type { LoopEvent } from "./loop.ts";
import type { ToolCall } from "./provider.ts";
import { type Approver, type Mode, Policy } from "./security.ts";

const MODES: readonly Mode[] = ["read-only", "safe", "yolo"];
const USAGE = 'usage: bun run trace [-p "task"] [-d workdir] [-m model] [--mode read-only|safe|yolo] [--resume] [--max-turns N]';
const ARG_CLIP = 100;

/** Shorten text to `max` characters on one line. */
function clip(text: string, max = ARG_CLIP): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** A call as "name {args}", with the arguments clipped. */
function describe(call: ToolCall): string {
  return `${call.name} ${clip(JSON.stringify(call.args))}`;
}

/**
 * An onEvent printer: assistant text plainly, each tool call on one line, and the first line of its result
 * dimmed under it. A turn without tool calls is the final answer, which the caller prints, so it is skipped.
 * `prefix` starts every line, so runs printing side by side stay apart.
 */
export function eventPrinter(prefix = ""): (event: LoopEvent) => void {
  const lead = prefix ? `${styleText("magenta", prefix)} ` : "";
  return (event) => {
    const { kind } = event;
    if (kind === "assistant" && event.completion.text && event.completion.toolCalls.length) {
      console.log(`${lead}${event.completion.text}`);
    }
    if (kind === "toolStart") console.log(`${lead}${styleText("cyan", `-> ${describe(event.call)}`)}`);
    if (kind === "toolEnd") console.log(`${lead}${styleText("dim", `   ${clip(event.result.split("\n")[0] ?? "")}`)}`);
  };
}

/** Ask in the terminal before a call runs in safe mode; anything but y or yes refuses. */
const approve: Approver = (call) => /^(y|yes)$/i.test(prompt(`approve ${describe(call)}? [y/N]`)?.trim() ?? "");

/** Run one task, exiting 130 with a pointer to --resume when Ctrl-C arrives mid-run. */
async function runTask(harness: Harness, task: string): Promise<string> {
  const interrupt = () => {
    console.log(`\n${styleText("yellow", "interrupted.")} The session log is safe: ${harness.sessionPath ?? "(none yet)"}`);
    console.log(`Run \`bun run trace --resume -d ${harness.workdir}\` to continue it.`);
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  try {
    return await harness.run(task);
  } finally {
    process.off("SIGINT", interrupt);
  }
}

/** Parse flags, then run one headless task (-p) or an interactive prompt loop. */
export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        prompt: { type: "string", short: "p" },
        workdir: { type: "string", short: "d", default: "." },
        model: { type: "string", short: "m" },
        mode: { type: "string" },
        resume: { type: "boolean", default: false },
        "max-turns": { type: "string", default: "120" },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  const headless = values.prompt !== undefined;
  const mode = values.mode ?? (headless ? "yolo" : "safe");
  const maxTurns = Number(values["max-turns"]);
  if (!MODES.includes(mode as Mode) || !Number.isInteger(maxTurns) || maxTurns < 1) {
    console.error(`bad --mode or --max-turns\n${USAGE}`);
    process.exit(2);
  }

  const harness = new Harness({
    workdir: values.workdir,
    model: values.model,
    policy: new Policy(mode as Mode, approve),
    onEvent: eventPrinter(),
    maxTurns,
  });
  if (values.resume) {
    const resumed = harness.resume();
    console.log(styleText("dim", resumed
      ? `resumed ${harness.sessionPath} (${harness.messages.length} messages)`
      : "no session to resume; starting fresh"));
  }

  if (headless) {
    console.log(`\n${await runTask(harness, values.prompt ?? "")}`);
    process.exit(0);
  }

  console.log(`${styleText("bold", "Trace")} · model ${harness.model} · mode ${mode} · jail ${harness.workdir}`);
  console.log(styleText("dim", "Type a task. Ctrl-D exits; Ctrl-C stops a run."));
  for (;;) {
    const task = prompt(styleText(["green", "bold"], "\ntrace>"));
    if (task === null) break;
    if (!task.trim()) continue;
    console.log(`\n${styleText(["green", "bold"], "final:")} ${await runTask(harness, task)}`);
  }
}

if (import.meta.main) await main();
