/**
 * Day 1 provider: the single seam between Trace and a language model.
 *
 * Concept: the harness speaks one neutral message format. This file
 * translates it to OpenRouter's OpenAI-style chat completions API and back,
 * so no other module knows which model or wire format is in use.
 *
 * Design rules: Bun built-ins only (fetch, Bun.sleep, AbortSignal); one
 * request function with bounded exponential retry; reasoning state is opaque
 * and round-tripped verbatim.
 */

export const API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";

/** A tool invocation requested by the model. */
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/** One turn in the neutral conversation format shared by the whole harness. */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; reasoning?: unknown[] }
  | { role: "tool"; id: string; name: string; text: string };

/** A tool offered to the model; `schema` is a JSON Schema function declaration. */
export type ToolSpec = { schema: { name: string; description: string; parameters: object } };

/** Token counts and OpenRouter's reported cost in USD for one or more model calls. */
export type Usage = { input: number; output: number; cost: number };

/** The parsed result of one model call; `model` is the model that actually served it. */
export type Completion = {
  text: string; toolCalls: ToolCall[]; reasoning?: unknown[]; model: string; usage: Usage;
};

type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type WireResponse = {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[]; reasoning_details?: unknown[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
};

const RETRY_STATUSES = new Set([429, 500, 502, 503]);

/** Return the OpenRouter key from TRACE_API_KEY, falling back to OPENROUTER_API_KEY. */
export function apiKey(): string {
  const key = Bun.env.TRACE_API_KEY || Bun.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("No API key: set TRACE_API_KEY or OPENROUTER_API_KEY to an OpenRouter key.");
  return key;
}

/** Send a conversation to the model; return its text, tool calls, reasoning, and token usage. */
export async function complete({ model = DEFAULT_MODEL, system, messages, tools }: {
  model?: string; system: string; messages: Message[]; tools?: ToolSpec[];
}): Promise<Completion> {
  const data = await post({
    model,
    messages: [{ role: "system", content: system }, ...toWire(messages)],
    temperature: 0.4,
    max_tokens: 65536,
    ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", function: t.schema })) } : {}),
  });
  // OpenRouter can answer 200 with an error object instead of choices.
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`);
  const message = data.choices?.[0]?.message ?? {};
  return {
    text: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((c) =>
      ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") })),
    reasoning: message.reasoning_details,
    model: data.model ?? model,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cost: data.usage?.cost ?? 0,
    },
  };
}

/** One wire encoder per neutral role; adding a role without an encoder is a type error. */
const ENCODERS: { [R in Message["role"]]: (m: Extract<Message, { role: R }>) => object } = {
  user: (m) => ({ role: "user", content: m.text }),
  tool: (m) => ({ role: "tool", tool_call_id: m.id, content: m.text }),
  assistant: (m) => ({
    role: "assistant",
    content: m.text || null,
    ...(m.toolCalls.length > 0 && {
      tool_calls: m.toolCalls.map((c) =>
        ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    }),
    // Reasoning models (Gemini 3 among them) keep thought signatures in
    // reasoning_details and reject tool-call turns that drop or alter them.
    ...(m.reasoning && { reasoning_details: m.reasoning }),
  }),
};

/** Map neutral messages to OpenAI-style chat messages. */
export function toWire(messages: Message[]): object[] {
  return messages.map((m) => (ENCODERS[m.role] as (m: Message) => object)(m));
}

/** Result of a single request: a parsed body, or an error worth retrying. Fatal errors throw. */
type Attempt = { done: WireResponse } | { retry: unknown };

/** Make one POST to OpenRouter and classify the result. */
async function attempt(body: object): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", "X-Title": "Trace" },
      body: JSON.stringify(body),
      // A non-streaming reply is silent until done, so Bun's 5-minute idle
      // timer would kill long generations; the signal is the real deadline.
      timeout: false,
      signal: AbortSignal.timeout(600_000),
    });
  } catch (err) {
    if (err instanceof TypeError || (err as Error)?.name === "TimeoutError") return { retry: err };
    throw err;
  }
  if (res.ok) return { done: (await res.json()) as WireResponse };
  const error = new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  if (RETRY_STATUSES.has(res.status)) return { retry: error };
  throw error;
}

/** POST a body to OpenRouter, retrying rate limits, server errors, network errors, and timeouts. */
async function post(body: object, retries = 5): Promise<WireResponse> {
  let outcome: Attempt = { retry: new Error("no attempts made") };
  for (let i = 0; i < retries; i++) {
    if (i > 0) await Bun.sleep(2 ** (i - 1) * 2000);
    outcome = await attempt(body);
    if ("done" in outcome) return outcome.done;
  }
  throw outcome.retry;
}
