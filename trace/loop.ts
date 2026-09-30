/**
 * Day 1 loop: the agent turn cycle.
 *
 * Concept: an agent is a loop. Ask the model, run the tools it requests, feed
 * the results back, and stop when it answers without calling a tool.
 *
 * Design rules: tool failures become tool results, never crashes; every tool
 * call gets exactly one result; running out of turns ends with a forced
 * tool-free answer, not an error.
 */
import { complete, type Completion, type Message, type ToolCall, type ToolSpec, type Usage } from "./provider.ts";

/** A callable tool: the schema shown to the model and the function that runs it. */
export type Tool = { spec: ToolSpec; run: (args: Record<string, unknown>) => unknown | Promise<unknown> };

/** Usage accumulated over a run: turns so far, overall totals, and totals per serving model. */
export type Meter = { turn: number; total: Usage; byModel: Record<string, Usage> };

/** Progress notifications emitted while the loop runs. `meter` is a snapshot taken after this turn. */
export type LoopEvent =
  | { kind: "modelStart"; turn: number }
  | { kind: "assistant"; completion: Completion; meter: Meter }
  | { kind: "toolStart"; call: ToolCall }
  | { kind: "toolEnd"; call: ToolCall; result: string };

/** Options for runLoop. `messages` is mutated in place and is the live history. */
export type LoopOptions = {
  model?: string; system: string; messages: Message[]; tools: Record<string, Tool>;
  onEvent: (event: LoopEvent) => void;
  beforeTool: (call: ToolCall) => string | undefined | Promise<string | undefined>;
  maxTurns?: number; beforeTurn?: (messages: Message[]) => Message[];
};

/** Run model turns and tool calls until the model answers without tools; return that answer. */
export async function runLoop(opts: LoopOptions): Promise<string> {
  const { model, system, messages, tools, onEvent, beforeTool, maxTurns = 80, beforeTurn } = opts;
  const specs = Object.values(tools).map((t) => t.spec);
  const meter: Meter = { turn: 0, total: emptyUsage(), byModel: {} };
  for (let turn = 0; turn < maxTurns; turn++) {
    // Replace the contents, not the array, so the caller's reference stays live.
    if (beforeTurn) messages.splice(0, messages.length, ...beforeTurn(messages));
    const completion = await step({ model, system, messages, tools: specs }, onEvent, meter);
    if (!completion.toolCalls.length) return completion.text;
    for (const call of completion.toolCalls) {
      onEvent({ kind: "toolStart", call });
      const text = await execute(call, tools, beforeTool);
      // Every call id needs a matching tool message, blocked or unknown calls
      // included, or the provider rejects the next turn.
      messages.push({ role: "tool", id: call.id, name: call.name, text });
      onEvent({ kind: "toolEnd", call, result: text });
    }
  }
  messages.push({ role: "user", text: "Turn limit reached; wrap up now." });
  return (await step({ model, system, messages }, onEvent, meter)).text;
}

/** Call the model once, append its reply (with reasoning, for the echo) to the history, meter it, and emit it. */
async function step(request: Parameters<typeof complete>[0], onEvent: LoopOptions["onEvent"], meter: Meter): Promise<Completion> {
  onEvent({ kind: "modelStart", turn: meter.turn + 1 });
  const completion = await complete(request);
  const { text, toolCalls, reasoning } = completion;
  request.messages.push({ role: "assistant", text, toolCalls, reasoning });
  meter.turn++;
  addUsage(meter.total, completion.usage);
  const modelUsage = meter.byModel[completion.model] ?? emptyUsage();
  meter.byModel[completion.model] = modelUsage;
  addUsage(modelUsage, completion.usage);
  onEvent({ kind: "assistant", completion, meter: structuredClone(meter) });
  return completion;
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cost: 0 };
}

function addUsage(into: Usage, usage: Usage): void {
  into.input += usage.input;
  into.output += usage.output;
  into.cost += usage.cost;
}

/** Run one tool call and return its result text. Tool errors become results; they never throw. */
async function execute(call: ToolCall, tools: LoopOptions["tools"], beforeTool: LoopOptions["beforeTool"]): Promise<string> {
  const reason = await beforeTool(call);
  if (reason !== undefined) return `BLOCKED: ${reason}`;
  const tool = tools[call.name];
  if (!tool) return `ERROR: unknown tool ${call.name}`;
  try {
    const result = await tool.run(call.args);
    // JSON.stringify(undefined) is undefined, so a tool that returns nothing still yields text.
    return typeof result === "string" ? result : (JSON.stringify(result) ?? String(result));
  } catch (err) {
    return err instanceof Error ? `ERROR: ${err.name}: ${err.message}` : `ERROR: ${String(err)}`;
  }
}
