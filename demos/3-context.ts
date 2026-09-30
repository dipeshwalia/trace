/**
 * Demo 3: context compaction, durable memory, and skills.
 *
 * Concept: the loop's beforeTurn hook keeps history inside a token budget,
 * TRACE.md carries facts into a fresh conversation through the system prompt,
 * and a skills/ folder changes behavior with no code changes.
 *
 * Design rules: work in a fresh scratch directory under the OS temp dir, or in
 * TRACE_WORKDIR when set; run in yolo mode so only the deny list and the path
 * check apply; print a line each time compaction fires.
 * Run with `bun demos/3-context.ts [scenario]`, where scenario is a name or
 * number from SCENARIOS; with no argument it asks in a terminal and runs
 * "compact" otherwise. Set TRACE_MODEL to override the model and TRACE_BUDGET
 * to override a scenario's token budget.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { styleText } from "node:util";
import { compact, estimateTokens } from "../trace/context.ts";
import { ConsoleLogger } from "../trace/logger.ts";
import { runLoop } from "../trace/loop.ts";
import { buildSystemPrompt, remember } from "../trace/memory.ts";
import type { Message } from "../trace/provider.ts";
import { Policy } from "../trace/security.ts";
import { catalogPrompt, useSkillTool } from "../trace/skills.ts";
import { coreTools } from "../trace/tools.ts";

/** Each scenario checks one step 4 requirement; `setup` prepares the working directory first. */
type Scenario = { about: string; task: string; budget?: number; setup?: (workdir: string) => void };

const BRAND_VOICE = `---
name: brand-voice
description: The house voice. Load this before writing any prose, notes, or docs.
---
# Brand voice

Write everything as a pirate: "Ahoy", "matey", "arr", "ye" and "yer", nautical
metaphors. Keep the facts accurate; only the voice changes.
`;

const SCENARIOS: Record<string, Scenario> = {
  compact: {
    about: "a long task finishes correctly while compaction fires mid-run",
    budget: 1500,
    task: "Create five files one.txt through five.txt, each with 20 lines of the word ping, one write_file at a time "
      + "with a read back after each; then MANIFEST.md listing each file and its line count verified with wc -l",
  },
  remember: {
    about: "a fact saved with remember() is known in a fresh conversation, from the system prompt alone",
    task: "What is our staging server called, and on which day do we deploy? Answer from what you already know.",
    setup: (workdir) => console.log(remember(workdir, "The staging server is named kestrel; deploys happen on Thursdays.")),
  },
  skill: {
    about: "a skills/brand-voice skill changes the voice of a writing task with zero code changes",
    task: "Write welcome.md: a three-sentence welcome note for new contributors to this project.",
    setup: (workdir) => {
      mkdirSync(join(workdir, "skills", "brand-voice"), { recursive: true });
      writeFileSync(join(workdir, "skills", "brand-voice", "SKILL.md"), BRAND_VOICE);
    },
  },
};

/** Pick a scenario from argv, else ask in a terminal, else run "compact". */
function choose(): string {
  const names = Object.keys(SCENARIOS);
  let pick = Bun.argv[2];
  if (!pick && process.stdin.isTTY) {
    for (const [i, name] of names.entries()) console.log(`  ${i + 1}. ${name}: ${SCENARIOS[name]?.about}`);
    pick = prompt("Run which scenario?", "1") ?? "1";
  }
  const name = names[Number(pick) - 1] ?? pick ?? "compact";
  if (!(name in SCENARIOS)) {
    console.error(`Unknown scenario "${name}". Choose one of: ${names.join(", ")}`);
    process.exit(1);
  }
  return name;
}

const name = choose();
const scenario = SCENARIOS[name] as Scenario;
const workdir = Bun.env.TRACE_WORKDIR ? resolve(Bun.env.TRACE_WORKDIR) : mkdtempSync(join(tmpdir(), "trace-context-"));
mkdirSync(workdir, { recursive: true });
scenario.setup?.(workdir);
const budget = Bun.env.TRACE_BUDGET ? Number(Bun.env.TRACE_BUDGET) : scenario.budget;
console.log(`\nscenario ${name}: ${scenario.about}\nworkdir: ${workdir}\nbudget: ${budget ?? "none"}\ntask: ${scenario.task}\n`);

const model = Bun.env.TRACE_MODEL;
const logger = new ConsoleLogger();
let compactions = 0;

/** compact() as the loop's beforeTurn, printing a line whenever it actually shrinks the history. */
async function beforeTurn(messages: Message[]): Promise<Message[]> {
  if (budget === undefined) return messages;
  const kept = await compact(model, messages, budget);
  if (kept !== messages) {
    compactions++;
    console.log(styleText(["yellow", "bold"], `[compacted] ${messages.length} messages (~${estimateTokens(messages)} tokens)`
      + ` -> ${kept.length} (~${estimateTokens(kept)} tokens)`));
  }
  return kept;
}

const answer = await runLoop({
  model,
  system: buildSystemPrompt(workdir, catalogPrompt(workdir)),
  messages: [{ role: "user", text: scenario.task }],
  tools: { ...coreTools(workdir), use_skill: useSkillTool(workdir) },
  onEvent: logger.onEvent,
  beforeTool: new Policy("yolo").check,
  beforeTurn,
}).finally(() => logger.stop());
logger.final(answer);
if (budget !== undefined) console.log(`${styleText("yellow", "compactions:")} ${compactions}`);
