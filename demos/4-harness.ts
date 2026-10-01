/**
 * Demo 4: the Harness, durable sessions, crash repair, and sub-agents.
 *
 * Concept: a Harness records every message to .trace/sessions as it lands,
 * so a process killed mid-task can resume() and finish; and spawn_agent hands
 * self-contained work to children whose context, and session log, stay
 * their own.
 *
 * Design rules: work in scratch/harness, or in TRACE_WORKDIR when set; crash
 * and delegate start from an empty scratch/harness but leave a TRACE_WORKDIR
 * as it is; resume continues the latest session in the same folder.
 * Run with `bun demos/4-harness.ts [scenario]`, where scenario is a name or
 * number from SCENARIOS; with no argument it asks in a terminal and runs
 * "crash" otherwise. To see a resume, run crash, `kill -9` it after
 * part2.txt exists and before SUMMARY.md does, then run resume.
 * Set TRACE_MODEL to override the model.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { styleText } from "node:util";
import { Harness } from "../trace/harness.ts";
import { ConsoleLogger } from "../trace/logger.ts";
import { INTERRUPTED, SESSION_DIR } from "../trace/session.ts";

/** Each scenario checks one step 5 requirement. `fresh` empties the default workdir first; `resume` continues the latest session. */
type Scenario = { about: string; task: string; fresh?: boolean; resume?: boolean };

const DEFAULT_WORKDIR = "scratch/harness";

const SCENARIOS: Record<string, Scenario> = {
  crash: {
    about: "a long task to kill -9 partway; every message is already in the session log",
    task: "Create part1.txt through part5.txt one at a time, then SUMMARY.md describing each",
    fresh: true,
  },
  resume: {
    about: "load the latest session, repair any interrupted tool call, and finish the task",
    task: "continue the task",
    resume: true,
  },
  delegate: {
    about: "two sub-agents write the code, the parent runs the tests, and only the parent keeps a session",
    task: "Use spawn_agent twice: delegate writing utils.ts with an exported slugify(text) function to one child, "
      + "and test_utils.ts with five assert calls from node:assert to another; then run bun test_utils.ts yourself and report",
    fresh: true,
  },
};

/** Pick a scenario from argv, else ask in a terminal, else run "crash". */
function choose(): string {
  const names = Object.keys(SCENARIOS);
  let pick = Bun.argv[2];
  if (!pick && process.stdin.isTTY) {
    for (const [i, name] of names.entries()) console.log(`  ${i + 1}. ${name}: ${SCENARIOS[name]?.about}`);
    pick = prompt("Run which scenario?", "1") ?? "1";
  }
  const name = names[Number(pick) - 1] ?? pick ?? "crash";
  if (!(name in SCENARIOS)) {
    console.error(`Unknown scenario "${name}". Choose one of: ${names.join(", ")}`);
    process.exit(1);
  }
  return name;
}

/** Files in the workdir, skipping the session directory. */
function files(workdir: string): string[] {
  return readdirSync(workdir).filter((f) => f !== ".trace").sort();
}

const name = choose();
const scenario = SCENARIOS[name] as Scenario;
const workdir = resolve(Bun.env.TRACE_WORKDIR ?? DEFAULT_WORKDIR);
if (scenario.fresh && !Bun.env.TRACE_WORKDIR) rmSync(workdir, { recursive: true, force: true });

const logger = new ConsoleLogger();
const harness = new Harness({ workdir, onEvent: logger.onEvent });
console.log(`\nscenario ${name}: ${scenario.about}\nworkdir: ${workdir}\npid: ${process.pid}`);

if (scenario.resume) {
  if (!harness.resume()) {
    console.error(`No session to resume in ${join(workdir, SESSION_DIR)}. Run crash first.`);
    process.exit(1);
  }
  console.log(`resumed: ${relative(process.cwd(), harness.sessionPath ?? "")} (${harness.messages.length} messages)`);
  for (const m of harness.messages) {
    if (m.role === "tool" && m.text === INTERRUPTED) {
      console.log(styleText(["yellow", "bold"], `[interrupted] ${m.name} (${m.id}): ${m.text}`));
    }
  }
}
console.log(`task: ${scenario.task}\n`);

try {
  logger.final(await harness.run(scenario.task));
} finally {
  logger.stop();
}

console.log(`${styleText("cyan", "session:")} ${relative(process.cwd(), harness.sessionPath ?? "")}`);
console.log(`${styleText("cyan", "files:")} ${files(workdir).join(", ") || "(none)"}`);
const sessionDir = join(workdir, SESSION_DIR);
const sessions = existsSync(sessionDir) ? readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")) : [];
console.log(`${styleText("cyan", "session files:")} ${sessions.length}`);
