/**
 * Sub-agents: delegate a task to a fresh harness with a clean context.
 *
 * Concept: a self-contained task does not need the parent's history, and
 * the parent does not need the child's. spawn_agent runs the task in a new
 * Harness and hands back only the child's final report, so the parent's
 * context grows by one tool result.
 *
 * Design rules: Harness is imported as a type only, so this file and
 * harness.ts do not form a runtime import cycle; depth is capped, and past
 * the cap the tool returns an ERROR telling the model to do the work itself.
 */
import type { Harness } from "./harness.ts";
import type { Tool } from "./loop.ts";
import { tool } from "./tools.ts";

/** The spawn_agent tool: run `task` in makeHarness(depth + 1) and return its final answer, until maxDepth. */
export function subagentTool(makeHarness: (depth: number) => Harness, depth = 0, maxDepth = 2): Tool {
  return tool({
    name: "spawn_agent",
    description: "Delegate a self-contained task to a fresh sub-agent with its own clean context. "
      + "The sub-agent cannot see this conversation, so put everything it needs in the task. "
      + "Returns the sub-agent's final report.",
    params: { task: { description: "The complete task, with every detail the sub-agent needs" } },
    run: async ({ task }) => {
      if (depth >= maxDepth) return "ERROR: sub-agent depth limit reached; do this task yourself";
      const child = makeHarness(depth + 1);
      return await child.run(String(task));
    },
  });
}
