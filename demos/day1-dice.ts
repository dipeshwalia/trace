/**
 * Day 1 demo: one hand-written tool driven by the agent loop.
 *
 * Concept: a tool is just a schema the model reads plus a function the harness
 * runs. The model decides when to call it; the loop does the rest.
 *
 * Design rules: validate tool input and throw on bad values, so the loop can
 * hand the error back to the model; log every event through ConsoleLogger so
 * the turn cycle is visible. Run with `bun demos/day1-dice.ts`; set
 * TRACE_MODEL to override the model.
 */
import { ConsoleLogger } from "../trace/logger.ts";
import { runLoop, type Tool } from "../trace/loop.ts";

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

const logger = new ConsoleLogger();
const task = "Roll 3 dice and tell me whether the total beats 10";
const answer = await runLoop({
  system: "You are a helpful assistant. Use tools when they help.",
  messages: [{ role: "user", text: task }],
  tools: { roll_dice: rollDice },
  onEvent: logger.onEvent,
  beforeTool: () => undefined,
  model: Bun.env.TRACE_MODEL,
}).finally(() => logger.stop());
logger.final(answer);
