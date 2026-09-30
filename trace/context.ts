/**
 * Context: keep the conversation inside a token budget.
 *
 * Concept: history grows every turn. Before each turn, compact() checks a
 * rough token estimate and, when over budget, has the model summarize the old
 * messages into one user message while the most recent ones stay verbatim.
 *
 * Design rules: standard library only; the estimate is characters divided by
 * CHARS_PER_TOKEN, not a tokenizer; one provider call per compaction; the
 * kept slice never starts with a tool result whose call was summarized away.
 * Pass `(messages) => compact(model, messages, budget)` as runLoop's beforeTurn.
 */
import { complete, type Message } from "./provider.ts";

export const CHARS_PER_TOKEN = 4;
export const KEEP_RECENT = 6;

const CLIP = 600;
const SYSTEM = "You compress agent transcripts. Preserve: the original task, every file created or edited and its "
  + "purpose, key decisions, unresolved errors, and what remains to be done. Be dense and factual.";

/** Rough token count of a message list: total serialized length divided by CHARS_PER_TOKEN. */
export function estimateTokens(messages: Message[]): number {
  return Math.floor(messages.reduce((n, m) => n + JSON.stringify(m).length, 0) / CHARS_PER_TOKEN);
}

/** Return the messages unchanged when within budget, else a model summary of the old ones plus the recent ones. */
export async function compact(model: string | undefined, messages: Message[], budgetTokens: number): Promise<Message[]> {
  if (estimateTokens(messages) <= budgetTokens || messages.length <= KEEP_RECENT + 1) return messages;
  const old = messages.slice(0, -KEEP_RECENT);
  const recent = messages.slice(-KEEP_RECENT);
  while (recent[0]?.role === "tool") recent.shift();
  const { text } = await complete({ model, system: SYSTEM, messages: [{ role: "user", text: transcript(old) }] });
  return [{ role: "user", text: `[Conversation so far, compacted]\n${text}` }, ...recent];
}

/** Render messages as plain text: role, tool name, clipped text, and the names of any tool calls. */
function transcript(messages: Message[]): string {
  return messages.map((m) => {
    const head = m.role === "tool" ? `tool (${m.name})` : m.role;
    const text = m.text.length > CLIP ? `${m.text.slice(0, CLIP)} ...` : m.text;
    const calls = m.role === "assistant" && m.toolCalls.length
      ? ` [called: ${m.toolCalls.map((c) => c.name).join(", ")}]` : "";
    return `${head}: ${text}${calls}`;
  }).join("\n\n");
}
