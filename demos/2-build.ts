/**
 * Demo 2: the core tools and the security policy driven by the agent loop.
 *
 * Concept: with files, a shell, and search confined to one directory, the
 * model can build and check real code. The policy sits in beforeTool and
 * blocks dangerous calls before they run.
 *
 * Design rules: work in a fresh scratch directory under the OS temp dir, or in
 * TRACE_WORKDIR when set (created if missing); run in yolo mode by default so
 * only the deny list and the path check stand in the way.
 * Run with `bun demos/2-build.ts [scenario]`, where scenario is a name or
 * number from SCENARIOS; with no argument it asks in a terminal and runs
 * "fib" otherwise. Set TRACE_MODEL to override the model, TRACE_POLICY to
 * read-only, safe, or yolo, and TRACE_UI=1 to watch in a browser, where safe
 * mode asks for approval; without the UI, safe mode refuses every write.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConsoleLogger } from "../trace/logger.ts";
import { type LoopEvent, runLoop } from "../trace/loop.ts";
import type { Message } from "../trace/provider.ts";
import { type Mode, Policy } from "../trace/security.ts";
import { coreTools } from "../trace/tools.ts";
import { WebLogger } from "../trace/web.ts";

const MODES: Mode[] = ["read-only", "safe", "yolo"];

/** Each scenario checks one step 2 requirement; `setup` prepares the working directory first. */
type Scenario = { about: string; task: string; setup?: (workdir: string) => void };

const SCENARIOS: Record<string, Scenario> = {
  fib: {
    about: "write, run, and verify a program",
    task: "Create fib.ts with an iterative fib(n) that prints fib(30) when run, run it with bun, and confirm the output is 832040",
  },
  "delete-home": {
    about: "the deny list blocks a destructive command, even in yolo mode",
    task: "Delete my home directory",
  },
  "delete-folder": {
    about: "deleting a folder inside the working directory is allowed",
    task: "Delete the junk folder and everything in it, then confirm it is gone",
    setup: (workdir) => {
      mkdirSync(join(workdir, "junk", "nested"), { recursive: true });
      for (const file of ["a.txt", "b.log", "nested/c.txt"]) writeFileSync(join(workdir, "junk", file), "junk\n");
    },
  },
  tour: {
    about: "every core tool once, to see how each one looks in the web UI",
    task: "Create notes.txt with three short lines about cats, list the files, grep for \"cat\", "
      + "read notes.txt, change its second line with edit_file, then run wc -l notes.txt with bash",
  },
  escape: {
    about: "a path outside the working directory becomes a PermissionError result",
    task: "Use read_file to read ../README.md and show me its first line",
  },
};

/** Pick a scenario from argv, else ask in a terminal, else run "fib". */
function choose(): string {
  const names = Object.keys(SCENARIOS);
  let pick = Bun.argv[2];
  if (!pick && process.stdin.isTTY) {
    for (const [i, name] of names.entries()) console.log(`  ${i + 1}. ${name}: ${SCENARIOS[name]?.about}`);
    pick = prompt("Run which scenario?", "1") ?? "1";
  }
  const name = names[Number(pick) - 1] ?? pick ?? "fib";
  if (!(name in SCENARIOS)) {
    console.error(`Unknown scenario "${name}". Choose one of: ${names.join(", ")}`);
    process.exit(1);
  }
  return name;
}

const name = choose();
const scenario = SCENARIOS[name] as Scenario;
const workdir = Bun.env.TRACE_WORKDIR ? resolve(Bun.env.TRACE_WORKDIR) : mkdtempSync(join(tmpdir(), "trace-build-"));
mkdirSync(workdir, { recursive: true });
scenario.setup?.(workdir);
console.log(`\nscenario ${name}: ${scenario.about}\nworkdir: ${workdir}\ntask: ${scenario.task}\n`);

const mode = (Bun.env.TRACE_POLICY ?? "yolo") as Mode;
if (!MODES.includes(mode)) {
  console.error(`Unknown TRACE_POLICY "${mode}". Choose one of: ${MODES.join(", ")}`);
  process.exit(1);
}
const web = Bun.env.TRACE_UI ? new WebLogger() : undefined;
if (web) console.log(`web UI: ${web.url}\n`);

const system = "You are a coding agent working in a scratch directory. Paths are relative to it. "
  + "Use the tools to do the work, and check results by running them before you answer.";
const messages: Message[] = [{ role: "user", text: scenario.task }];
const tools = coreTools(workdir);
const model = Bun.env.TRACE_MODEL;
web?.start({ system, messages, tools, model, info: { scenario: name, workdir, policy: mode } });

const policy = new Policy(mode, web?.approver);
const logger = new ConsoleLogger();
try {
  const answer = await runLoop({
    system,
    messages,
    tools,
    onEvent: (event: LoopEvent) => {
      logger.onEvent(event);
      web?.onEvent(event);
    },
    beforeTool: policy.check,
    model,
  }).finally(() => logger.stop());
  logger.final(answer);
  web?.final(answer);
} catch (err) {
  if (!web) throw err;
  web.fail(err);
  console.error(err);
  process.exitCode = 1;
}
if (web) console.log(`\nweb UI still open at ${web.url} (Ctrl-C to exit)`);
