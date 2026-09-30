/**
 * Demo 2: the core tools and the security policy driven by the agent loop.
 *
 * Concept: with files, a shell, and search confined to one directory, the
 * model can build and check real code. The policy sits in beforeTool and
 * blocks dangerous calls before they run.
 *
 * Design rules: work in a fresh scratch directory under the OS temp dir, or in
 * TRACE_WORKDIR when set (created if missing); run in yolo mode so only the
 * deny list and the path check stand in the way.
 * Run with `bun demos/2-build.ts [scenario]`, where scenario is a name or
 * number from SCENARIOS; with no argument it asks in a terminal and runs
 * "fib" otherwise. Set TRACE_MODEL to override the model.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConsoleLogger } from "../trace/logger.ts";
import { runLoop } from "../trace/loop.ts";
import { Policy } from "../trace/security.ts";
import { coreTools } from "../trace/tools.ts";

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

const policy = new Policy("yolo");
const logger = new ConsoleLogger();
const answer = await runLoop({
  system: "You are a coding agent working in a scratch directory. Paths are relative to it. "
    + "Use the tools to do the work, and check results by running them before you answer.",
  messages: [{ role: "user", text: scenario.task }],
  tools: coreTools(workdir),
  onEvent: logger.onEvent,
  beforeTool: policy.check,
  model: Bun.env.TRACE_MODEL,
}).finally(() => logger.stop());
logger.final(answer);
