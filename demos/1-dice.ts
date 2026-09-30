/**
 * Demo 1: one hand-written tool driven by the agent loop.
 *
 * Concept: a tool is just a schema the model reads plus a function the harness
 * runs. The model decides when to call it; the loop does the rest.
 *
 * Design rules: validate tool input and throw on bad values, so the loop can
 * hand the error back to the model; log every event through ConsoleLogger so
 * the turn cycle is visible. Run with `bun demos/1-dice.ts [scenario]`, where
 * scenario is a name or number from SCENARIOS; with no argument it asks in a
 * terminal and runs "basic" otherwise. Set TRACE_MODEL to override the model.
 * Set TRACE_UI=1 to also watch the run in a browser; the page stays up until
 * Ctrl-C.
 */
import { ConsoleLogger } from "../trace/logger.ts";
import { type LoopEvent, runLoop, type Tool } from "../trace/loop.ts";
import type { Message, ToolCall } from "../trace/provider.ts";
import { WebLogger } from "../trace/web.ts";

/** Roll `count` six-sided dice and report each roll and the total. */
const rollDice: Tool = {
  spec: {
    schema: {
      name: "roll_dice",
      description: "Roll count six-sided dice",
      parameters: {
        type: "object",
        properties: { count: { type: "integer", description: "How many dice, 1 to 100" } },
        required: ["count"],
      },
    },
  },
  run: ({ count }) => {
    // Models sometimes send numbers as strings, so coerce before checking.
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new RangeError(`count must be an integer from 1 to 100, got ${count}`);
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
    return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
  },
};

/** Each scenario drives one loop behavior with the same tool. */
type Scenario = { about: string; task: string; maxTurns?: number; approve?: boolean };

const SCENARIOS: Record<string, Scenario> = {
  basic: {
    about: "one tool call, then a plain answer ends the loop",
    task: "Roll 3 dice and tell me whether the total beats 10",
  },
  "bad-args": {
    about: "the tool throws, the model gets an ERROR result and recovers",
    task: "Call roll_dice with count 150 exactly, even if you expect it to fail. If it fails, recover and still tell me the total of 150 dice",
  },
  parallel: {
    about: "several tool calls in one turn, one result per call id",
    task: "Roll 2 dice each for Alice, Bob, and Carol, one call per person, and tell me who wins",
  },
  "turn-limit": {
    about: "maxTurns runs out, the loop forces a tool-free wrap-up",
    task: "Roll 1 die per call, one call per turn, 5 times in total, then tell me the sum of all 5 rolls",
    maxTurns: 2,
  },
  approve: {
    about: "every call waits for Approve or Deny in the web UI (needs TRACE_UI=1)",
    task: "Roll 2 dice, then roll 2 more in a separate call, and tell me both totals. If a roll is denied, say so",
    approve: true,
  },
};

/** Pick a scenario from argv, else ask in a terminal, else run "basic". */
function choose(): string {
  const names = Object.keys(SCENARIOS);
  let pick = Bun.argv[2];
  if (!pick && process.stdin.isTTY) {
    for (const [i, name] of names.entries()) console.log(`  ${i + 1}. ${name}: ${SCENARIOS[name]?.about}`);
    pick = prompt("Run which scenario?", "1") ?? "1";
  }
  const name = names[Number(pick) - 1] ?? pick ?? "basic";
  if (!(name in SCENARIOS)) {
    console.error(`Unknown scenario "${name}". Choose one of: ${names.join(", ")}`);
    process.exit(1);
  }
  return name;
}

const name = choose();
const scenario = SCENARIOS[name] as Scenario;
console.log(`\nscenario ${name}: ${scenario.about}\ntask: ${scenario.task}\n`);

const web = Bun.env.TRACE_UI ? new WebLogger() : undefined;
if (scenario.approve && !web) {
  console.error(`Scenario "${name}" needs the web UI: run it with TRACE_UI=1.`);
  process.exit(1);
}
if (web) console.log(`web UI: ${web.url}\n`);

const system = "You are a helpful assistant. Use tools when they help.";
const messages: Message[] = [{ role: "user", text: scenario.task }];
const tools = { roll_dice: rollDice };
const model = Bun.env.TRACE_MODEL;
web?.start({ system, messages, tools, model });

const logger = new ConsoleLogger();
const beforeTool = web && scenario.approve
  ? async (call: ToolCall) => ((await web.approver(call, "This scenario asks before every tool call.")) ? undefined : "denied in the web UI")
  : () => undefined;
try {
  const answer = await runLoop({
    system,
    messages,
    tools,
    onEvent: (event: LoopEvent) => {
      logger.onEvent(event);
      web?.onEvent(event);
    },
    beforeTool,
    model,
    maxTurns: scenario.maxTurns,
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
