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

/** The parsed result of one model call. */
export type Completion = {
  text: string; toolCalls: ToolCall[]; reasoning?: unknown[]; usage: { input: number; output: number };
};

type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type WireResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[]; reasoning_details?: unknown[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: system }, ...toWire(messages)],
    temperature: 0.4,
    max_tokens: 65536,
  };
  if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: t.schema }));

  const data = await post(body);
  // OpenRouter can answer 200 with an error object instead of choices.
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`);
  const message = data.choices?.[0]?.message ?? {};
  return {
    text: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((c) =>
      ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") })),
    reasoning: message.reasoning_details,
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
  };
}

/** Map neutral messages to OpenAI-style chat messages. */
export function toWire(messages: Message[]): object[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "tool") return { role: "tool", tool_call_id: m.id, content: m.text };
    const wire: Record<string, unknown> = { role: "assistant", content: m.text || null };
    if (m.toolCalls.length) {
      wire.tool_calls = m.toolCalls.map((c) =>
        ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    }
    // Reasoning models (Gemini 3 among them) keep thought signatures in
    // reasoning_details and reject tool-call turns that drop or alter them.
    if (m.reasoning) wire.reasoning_details = m.reasoning;
    return wire;
  });
}

/** POST a body to OpenRouter, retrying rate limits, server errors, network errors, and timeouts. */
async function post(body: object, retries = 5): Promise<WireResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await Bun.sleep(2 ** (attempt - 1) * 2000);
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", "X-Title": "Trace" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (err) {
      const retryable = err instanceof TypeError || (err as Error)?.name === "TimeoutError";
      if (!retryable) throw err;
      lastError = err;
      continue;
    }
    if (res.ok) return (await res.json()) as WireResponse;
    const error = new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    if (!RETRY_STATUSES.has(res.status)) throw error;
    lastError = error;
  }
  throw lastError;
}
