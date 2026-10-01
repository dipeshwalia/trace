/**
 * Harness: the whole agent behind one object.
 *
 * Concept: the earlier modules are parts; the Harness composes them. It
 * builds the tools, the system prompt, and the policy for one working
 * directory, runs tasks through runLoop with compaction, and records every
 * message to a session file so a killed process can resume() where it
 * stopped.
 *
 * Design rules: Bun and Node standard library only; every option has a
 * default; each message is appended to the session as soon as it lands;
 * sub-agents share the workdir and policy but never persist, so a child's
 * log can never hijack resume(); when persist is false nothing is written.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { compact } from "./context.ts";
import { type LoopEvent, runLoop, type Tool } from "./loop.ts";
import { buildSystemPrompt, rememberTool } from "./memory.ts";
import { DEFAULT_MODEL, type Message } from "./provider.ts";
import { Policy } from "./security.ts";
import { append, latest, load, newSession } from "./session.ts";
import { catalog, catalogPrompt, useSkillTool } from "./skills.ts";
import { subagentTool } from "./subagent.ts";
import { coreTools } from "./tools.ts";

/** Options for a Harness; every field is optional. */
export type HarnessOptions = {
  workdir?: string; model?: string; policy?: Policy; extraTools?: Record<string, Tool>; systemExtra?: string;
  onEvent?: (event: LoopEvent) => void; budgetTokens?: number; maxTurns?: number; sessionPath?: string;
  enableSubagents?: boolean; persist?: boolean; depth?: number;
};

/** An agent bound to one working directory: tools, system prompt, policy, history, and its session file. */
export class Harness {
  readonly workdir: string;
  readonly model: string;
  readonly policy: Policy;
  readonly tools: Record<string, Tool>;
  readonly system: string;
  readonly depth: number;
  /** The live history; runLoop mutates it in place. */
  messages: Message[] = [];
  /** The session file, set by the first persisted run() or by resume(). */
  sessionPath: string | undefined;
  private readonly onEvent: (event: LoopEvent) => void;
  private readonly budgetTokens: number;
  private readonly maxTurns: number;
  private readonly persist: boolean;
  /** How many of `messages` are already in the session file. */
  private recorded = 0;

  constructor({
    workdir = ".", model, policy, extraTools, systemExtra = "", onEvent, budgetTokens = 600_000, maxTurns = 120,
    sessionPath, enableSubagents = true, persist = true, depth = 0,
  }: HarnessOptions = {}) {
    mkdirSync(workdir, { recursive: true });
    this.workdir = realpathSync(workdir);
    this.model = model ?? Bun.env.TRACE_MODEL ?? DEFAULT_MODEL;
    this.policy = policy ?? new Policy("yolo");
    this.onEvent = onEvent ?? (() => {});
    this.budgetTokens = budgetTokens;
    this.maxTurns = maxTurns;
    this.sessionPath = sessionPath;
    this.persist = persist;
    this.depth = depth;

    const tools: Record<string, Tool> = { ...coreTools(this.workdir), remember: rememberTool(this.workdir) };
    if (Object.keys(catalog(this.workdir)).length) tools.use_skill = useSkillTool(this.workdir);
    if (enableSubagents) {
      const makeChild = (childDepth: number) =>
        new Harness({ workdir: this.workdir, model: this.model, policy: this.policy, persist: false, depth: childDepth });
      tools.spawn_agent = subagentTool(makeChild, depth);
    }
    this.tools = { ...tools, ...extraTools };
    const extra = [catalogPrompt(this.workdir), systemExtra].filter(Boolean).join("\n\n");
    this.system = buildSystemPrompt(this.workdir, extra);
  }

  /**
   * Load a session, the latest in the workdir when no path is given, and continue it on the next run().
   * The file is rewritten with the repaired history, so a torn tail or a synthesized result never strands
   * later appends. Returns true when any messages were loaded.
   */
  resume(path?: string): boolean {
    const target = path ?? latest(this.workdir);
    if (!target) return false;
    this.messages = load(target);
    this.sessionPath = target;
    if (this.persist) {
      writeFileSync(target, "");
      for (const message of this.messages) append(target, message);
    }
    this.recorded = this.messages.length;
    return this.messages.length > 0;
  }

  /** Run one task on top of the current history and return the final answer. */
  async run(task: string): Promise<string> {
    if (this.persist && !this.sessionPath) this.sessionPath = newSession(this.workdir, task.slice(0, 32));
    this.messages.push({ role: "user", text: task });
    this.record();
    const answer = await runLoop({
      model: this.model,
      system: this.system,
      messages: this.messages,
      tools: this.tools,
      onEvent: (event) => {
        if (event.kind === "assistant" || event.kind === "toolEnd") this.record();
        this.onEvent(event);
      },
      beforeTool: this.policy.check,
      beforeTurn: async (messages) => {
        const kept = await compact(this.model, messages, this.budgetTokens);
        // Everything before a turn is already on disk; the log keeps the full history, not the summary.
        if (kept !== messages) this.recorded = kept.length;
        return kept;
      },
      maxTurns: this.maxTurns,
    });
    this.record();
    return answer;
  }

  /** Append the messages not yet in the session file. */
  private record(): void {
    // Compaction replaces the array's contents with a shorter list.
    this.recorded = Math.min(this.recorded, this.messages.length);
    if (this.persist && this.sessionPath) {
      for (const message of this.messages.slice(this.recorded)) append(this.sessionPath, message);
    }
    this.recorded = this.messages.length;
  }
}
