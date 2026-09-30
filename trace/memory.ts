/**
 * Memory: the system prompt and the notes that outlive a conversation.
 *
 * Concept: a fresh conversation knows nothing, so durable facts live in
 * TRACE.md in the working directory and are read into every system prompt.
 * An AGENTS.md there, the file other coding agents read, rides in too.
 *
 * Design rules: Node standard library only; memory is a plain Markdown file
 * the user can read and edit; remember() only appends.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./loop.ts";
import { tool } from "./tools.ts";

export const MEMORY_FILE = "TRACE.md";
/** The cross-agent instructions file from https://agents.md, read from the working directory only. */
export const AGENTS_FILE = "AGENTS.md";

export const BASE_PROMPT = "You are Trace, a small, sharp coding agent working inside one directory with the tools provided. "
  + "Act; don't narrate. Inspect before assuming. Prefer edit_file for small changes. "
  + "After building something, verify it by running it or re-reading it. Never repeat a failing call unchanged. "
  + "When the task is complete, reply with a short summary and stop calling tools.";

/**
 * The base prompt, the platform and real working directory, AGENTS.md and project memory when present,
 * and `extra`.
 */
export function buildSystemPrompt(workdir: string, extra = ""): string {
  const parts = [BASE_PROMPT, `Platform: ${process.platform}. Working directory: ${realpathSync(workdir)}.`];
  const agents = join(workdir, AGENTS_FILE);
  if (existsSync(agents)) parts.push(`Project instructions (${AGENTS_FILE}):\n${readFileSync(agents, "utf8")}`);
  const memory = join(workdir, MEMORY_FILE);
  if (existsSync(memory)) parts.push(`Project memory (${MEMORY_FILE}):\n${readFileSync(memory, "utf8")}`);
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}

/** Append a note to the project memory file. */
export function remember(workdir: string, note: string): string {
  appendFileSync(join(workdir, MEMORY_FILE), `- ${note}\n`);
  return `Remembered in ${MEMORY_FILE}`;
}

/** The remember tool, which lets the model save a durable fact for future conversations. */
export function rememberTool(workdir: string): Tool {
  return tool({
    name: "remember",
    description: "Save a short, durable fact about this project so future conversations know it",
    params: { note: { description: "One self-contained sentence" } },
    run: ({ note }) => remember(workdir, String(note)),
  });
}
