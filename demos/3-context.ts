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
 * Run with `bun demos/3-context.ts [scenario] [input]`, where scenario is a name or
 * number from SCENARIOS; with no argument it asks in a terminal and runs
 * "compact" otherwise. learn and recall take the fact or question as input,
 * or ask for it in a terminal. commit runs twice, in with/ and without/ under
 * a new scratch/skill-compare/<time>/ folder, so every run's output is kept
 * and runs can overlap; it ignores TRACE_WORKDIR and TRACE_UI.
 * Set TRACE_MODEL to override the model, TRACE_BUDGET to override a
 * scenario's token budget, and TRACE_UI=1 to watch in a browser,
 * with context size, compactions, memory, and skills in their own panels.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { styleText } from "node:util";
import { compact, estimateTokens } from "../trace/context.ts";
import { ConsoleLogger } from "../trace/logger.ts";
import { type LoopEvent, runLoop, type Tool } from "../trace/loop.ts";
import { AGENTS_FILE, buildSystemPrompt, MEMORY_FILE, remember, rememberTool } from "../trace/memory.ts";
import type { Message } from "../trace/provider.ts";
import { Policy } from "../trace/security.ts";
import { catalogPrompt, useSkillTool } from "../trace/skills.ts";
import { coreTools } from "../trace/tools.ts";
import { WebLogger } from "../trace/web.ts";

/** A task built from user input: argv[3], else an answer typed in a terminal, else `fallback`. */
type Ask = { question: string; fallback: string; task: (input: string) => string };

/**
 * Each scenario checks one step 4 requirement; `setup` prepares the working directory first.
 * `persist` names a folder under scratch/ that separate runs share; `tools` replaces the default tool set.
 * `compare` names an output file: the task runs in COMPARE_WORKDIR/<time>/with, which gets demos/skills/, and
 * in COMPARE_WORKDIR/<time>/without, which does not, and the two files are printed side by side.
 */
type Scenario = {
  about: string; task: string | Ask; budget?: number; persist?: string; compare?: string;
  setup?: (workdir: string) => void; tools?: (workdir: string) => Record<string, Tool>;
};

const MEMORY_WORKDIR = "scratch/memory";
const AGENTS_WORKDIR = "scratch/agents";
const COMPARE_WORKDIR = "scratch/skill-compare";
const SKILLS_SOURCE = join(import.meta.dir, "skills");
const FIXTURES = join(import.meta.dir, "fixtures");

const BRAND_VOICE = `---
name: brand-voice
description: The house voice. Load this before writing any prose, notes, or docs.
---
# Brand voice

Write everything as a pirate: "Ahoy", "matey", "arr", "ye" and "yer", nautical
metaphors. Keep the facts accurate; only the voice changes.
`;

const AGENTS = `# AGENTS.md

## Testing instructions

- The local test database listens on port 55431, not the Postgres default.
- Run \`bun test\` before committing.

## Release instructions

- Releases are approved by Oduya Mensah; nobody else can sign off.
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
  learn: {
    about: "the model saves a fact with the remember tool into a TRACE.md that outlives this process",
    persist: MEMORY_WORKDIR,
    task: {
      question: "What should Trace remember?",
      fallback: "the release codename is Marigold-7 and the on-call engineer is Priya",
      task: (fact) => `Remember this for future sessions: ${fact}`,
    },
    tools: (workdir) => ({ remember: rememberTool(workdir) }),
  },
  recall: {
    about: "a new process with no tools answers from TRACE.md alone; run it before and after learn",
    persist: MEMORY_WORKDIR,
    task: {
      question: "What do you want to ask?",
      fallback: "What is the release codename, and who is on call?",
      task: (question) => `${question} Answer from what you already know; you have no tools. `
        + "If you don't know, say so; don't guess.",
    },
    setup: (workdir) => {
      const memory = join(workdir, MEMORY_FILE);
      console.log(existsSync(memory) ? `${MEMORY_FILE}:\n${readFileSync(memory, "utf8")}` : `no ${MEMORY_FILE} yet`);
    },
    tools: () => ({}),
  },
  agents: {
    about: "a fresh session with no tools answers a question that only AGENTS.md in the working directory answers",
    persist: AGENTS_WORKDIR,
    task: {
      question: "What do you want to ask?",
      fallback: "Which port does the local test database listen on, and who approves releases?",
      task: (question) => `${question} Answer from what you already know; you have no tools. `
        + "If you don't know, say so; don't guess.",
    },
    setup: (workdir) => {
      const file = join(workdir, AGENTS_FILE);
      if (!existsSync(file)) writeFileSync(file, AGENTS);
      console.log(`${relative(process.cwd(), file)}:\n${readFileSync(file, "utf8")}`);
    },
    tools: () => ({}),
  },
  commit: {
    about: "the same commit message task, with and without the commit-message skill, printed side by side",
    compare: "COMMIT_MSG.txt",
    task: "Read change.diff and write a commit message for it to COMMIT_MSG.txt.",
    setup: (workdir) => copyFileSync(join(FIXTURES, "remember-tool.diff"), join(workdir, "change.diff")),
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

/** The scenario's task, filling an Ask from argv[3] or the terminal. */
function taskFor(task: string | Ask): string {
  if (typeof task === "string") return task;
  let input = Bun.argv[3];
  if (!input && process.stdin.isTTY) input = prompt(task.question, task.fallback) ?? "";
  return task.task(input?.trim() || task.fallback);
}

/** Two texts in columns `width` wide, with long lines cut to fit. */
function sideBySide(left: string, right: string, width = 80): string {
  const cut = (text: string) => text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${width}}`, "g")) ?? [""]);
  const [l, r] = [cut(left), cut(right)];
  return Array.from({ length: Math.max(l.length, r.length) },
    (_, i) => `${(l[i] ?? "").padEnd(width)} | ${r[i] ?? ""}`).join("\n");
}

const name = choose();
const scenario = SCENARIOS[name] as Scenario;
const budget = Bun.env.TRACE_BUDGET ? Number(Bun.env.TRACE_BUDGET) : scenario.budget;
const model = Bun.env.TRACE_MODEL;
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

/** Run `task` once in `workdir`, with the system prompt and skills built from that folder. */
async function run(workdir: string, task: string, web?: WebLogger): Promise<void> {
  console.log(`\nscenario ${name}: ${scenario.about}\nworkdir: ${workdir}\nbudget: ${budget ?? "none"}\ntask: ${task}\n`);
  const logger = new ConsoleLogger();
  const system = buildSystemPrompt(workdir, catalogPrompt(workdir));
  const messages: Message[] = [{ role: "user", text: task }];
  const tools = scenario.tools?.(workdir) ?? { ...coreTools(workdir), use_skill: useSkillTool(workdir) };
  web?.start({ system, messages, tools, model, workdir, budget, info: { scenario: name, policy: "yolo" } });
  try {
    const answer = await runLoop({
      model,
      system,
      messages,
      tools,
      onEvent: (event: LoopEvent) => {
        logger.onEvent(event);
        web?.onEvent(event);
      },
      beforeTool: new Policy("yolo").check,
      beforeTurn: web ? web.beforeTurn(beforeTurn) : beforeTurn,
    }).finally(() => logger.stop());
    logger.final(answer);
    web?.final(answer);
  } catch (err) {
    if (!web) throw err;
    web.fail(err);
    console.error(err);
    process.exitCode = 1;
  }
}

let web: WebLogger | undefined;
if (scenario.compare) {
  const output = scenario.compare;
  mkdirSync(COMPARE_WORKDIR, { recursive: true });
  const runDir = resolve(mkdtempSync(join(COMPARE_WORKDIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-`)));
  const withSkill = join(runDir, "with");
  const withoutSkill = join(runDir, "without");
  const task = taskFor(scenario.task);
  for (const workdir of [withSkill, withoutSkill]) {
    mkdirSync(workdir, { recursive: true });
    scenario.setup?.(workdir);
    if (workdir === withSkill) cpSync(SKILLS_SOURCE, join(workdir, "skills"), { recursive: true });
    await run(workdir, task);
  }
  const show = (label: string, workdir: string) => {
    const file = join(workdir, output);
    const text = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : `(no ${output} written)`;
    return `${label}: ${relative(process.cwd(), file)}\n${"-".repeat(40)}\n${text}`;
  };
  console.log(`\n${sideBySide(show("with skill", withSkill), show("without skill", withoutSkill))}`);
} else {
  const workdir = Bun.env.TRACE_WORKDIR ? resolve(Bun.env.TRACE_WORKDIR)
    : scenario.persist ? resolve(scenario.persist) : mkdtempSync(join(tmpdir(), "trace-context-"));
  mkdirSync(workdir, { recursive: true });
  scenario.setup?.(workdir);
  const task = taskFor(scenario.task);
  web = Bun.env.TRACE_UI ? new WebLogger() : undefined;
  if (web) console.log(`web UI: ${web.url}\n`);
  await run(workdir, task, web);
}
if (budget !== undefined) console.log(`${styleText("yellow", "compactions:")} ${compactions}`);
if (web) console.log(`\nweb UI still open at ${web.url} (Ctrl-C to exit)`);
