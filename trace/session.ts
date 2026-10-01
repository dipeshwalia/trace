/**
 * Session: a conversation that survives the process.
 *
 * Concept: every message is appended to a JSONL file the moment it lands, so
 * a crash loses at most the line being written. load() reads the file back
 * and repairs what a crash leaves behind, so the history can go straight to
 * the model again.
 *
 * Design rules: Node standard library only; one JSON line per message,
 * UTF-8, append-only; a line that fails to parse is a torn tail and ends the
 * read; repair pairs results to calls by id, so after load() every call id
 * of the last assistant message has exactly one tool message, as loop.ts
 * requires.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "./provider.ts";

export const SESSION_DIR = ".trace/sessions";

/** The tool result that stands in for a call the process died before running. */
export const INTERRUPTED = "Interrupted before this ran (process restarted).";

/** Create the session directory and return a new path, <workdir>/.trace/sessions/<unix-timestamp>-<slug>.jsonl. */
export function newSession(workdir: string, label = "session"): string {
  const dir = join(workdir, SESSION_DIR);
  mkdirSync(dir, { recursive: true });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "session";
  return join(dir, `${Math.floor(Date.now() / 1000)}-${slug}.jsonl`);
}

/** Append one message to a session file as a single JSON line. */
export function append(path: string, message: Message): void {
  appendFileSync(path, `${JSON.stringify(message)}\n`, "utf8");
}

/** Read a session file up to any torn tail, then add a tool message for every call of the last assistant message that has none. */
export function load(path: string): Message[] {
  const messages: Message[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      break;
    }
  }
  return repair(messages);
}

/** The most recently written .jsonl in the workdir's session directory, or undefined. */
export function latest(workdir: string): string | undefined {
  const dir = join(workdir, SESSION_DIR);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  return files
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))[0]?.path;
}

/** Append an INTERRUPTED result for each call of the last assistant message whose id has no tool message after it. */
function repair(messages: Message[]): Message[] {
  const last = messages.findLastIndex((m) => m.role === "assistant");
  const assistant = messages[last];
  if (assistant?.role !== "assistant") return messages;
  const answered = new Set(messages.slice(last + 1).flatMap((m) => (m.role === "tool" ? [m.id] : [])));
  for (const call of assistant.toolCalls) {
    if (!answered.has(call.id)) messages.push({ role: "tool", id: call.id, name: call.name, text: INTERRUPTED });
  }
  return messages;
}
