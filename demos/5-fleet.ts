/**
 * Demo 5: a fleet of harnesses builds real projects, then reviews them.
 *
 * Concept: runFleet runs one Harness per project side by side. Each project
 * folder gets a design-engineering skill that sets the quality bar; phase one
 * builds, and phase two resumes the same session for a design-director
 * review. Mechanical checks then decide pass or fail, and a project that
 * fails gets one more review pass, never a lower bar.
 *
 * Design rules: each project works in scratch/fleet/<name>, or under
 * TRACE_WORKDIR when set, and a build starts from an empty folder; yolo mode,
 * so only the deny list, the path check, and the bash sandbox apply; turns are
 * the assistant lines in a project's session file.
 * Run with `bun demos/5-fleet.ts [scenario] [projects]`, where scenario is a
 * name or number from SCENARIOS; with no argument it asks in a terminal and
 * runs "all" otherwise. review and verify take a comma-separated project list,
 * defaulting to all three. Set TRACE_MODEL to override the model.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { styleText } from "node:util";
import { eventPrinter } from "../trace/cli.ts";
import { type FleetResult, runFleet } from "../trace/fleet.ts";
import { Harness } from "../trace/harness.ts";
import { Policy } from "../trace/security.ts";
import { latest } from "../trace/session.ts";

const FLEET_DIR = resolve(Bun.env.TRACE_WORKDIR ?? "scratch/fleet");

const SKILL = `---
name: design-engineering
description: The quality bar for anything a person sees or uses. Load this before building or reviewing any page, game, or tool.
---
# Design engineering

Meet this quality bar: a real design system as CSS custom properties; at least 9 distinct sections for a landing page; at
least 1,200 words of real copy, no lorem ipsum; at least 4 hand-drawn inline SVG illustrations, one being a product
artifact in the hero; at least 3 working interactive behaviors; responsive at 360, 768, and 1280; semantic HTML with
focus states; a self-review pass before finishing that counts sections, words, SVGs, and interactions against these
minimums and fixes any shortfall.

For something that is not a landing page, such as a game or a command line tool, meet every part of the bar that
applies to it.

Write large files in parts: create a skeleton with write_file, then add or change one section at a time with
edit_file. A single tool call holding a whole large page can fail to generate.
`;

const REVIEW = "Review every file you produced against the skill bar as a demanding design director; "
  + "list 12 concrete deficiencies; fix them all; verify again.";

/** One mechanical check and what it found. */
type Check = { label: string; ok: boolean; detail?: string };

/** A project: its build task, its mechanical checks, and a one-line summary of what it contains. */
type Project = { task: string; checks: (dir: string) => Check[]; contents: (dir: string) => string };

/** Each scenario picks the projects and the phases to run; `review` and `verify` read projects from argv[3]. */
type Scenario = { about: string; projects?: string[]; phases: ("build" | "review")[] };

const PROJECTS: Record<string, Project> = {
  "artisan-coffee": {
    task: "Build artisan-coffee: a self-contained index.html for a specialty coffee roaster in Goa: sticky nav, hero "
      + "with a drawn product artifact, six origin cards with prices, a three-tier subscription table with a working "
      + "monthly/annual toggle, brew-guide tabs, an FAQ accordion, a dark-mode toggle persisted to localStorage. "
      + "Load the design-engineering skill first and meet its bar. Build the page in parts, a section at a time.",
    checks: (dir) => {
      const html = read(dir, "index.html");
      return [
        { label: "index.html exists", ok: html !== undefined },
        { label: "uses localStorage", ok: /localStorage/.test(html ?? "") },
        { label: "has an FAQ accordion", ok: /accordion|<details/i.test(html ?? "") },
        { label: "over 1,200 visible words", ok: visibleWords(html ?? "") > 1200, detail: `${visibleWords(html ?? "")} words` },
      ];
    },
    contents: (dir) => {
      const html = read(dir, "index.html") ?? "";
      return `${files(dir)}; ${visibleWords(html)} words, ${count(html, /<section\b/g)} sections, ${count(html, /<svg\b/g)} SVGs`;
    },
  },
  taskman: {
    task: "Build taskman: a TypeScript CLI task manager run with bun: subcommands add, list, done, rm, and stats "
      + "parsed with parseArgs from node:util; JSON persistence; aligned table output; a bun test suite of 10+ cases "
      + "that runs the CLI through Bun.spawn against a temp store inside this folder; run bun test until all tests "
      + "are green. Load the design-engineering skill first and meet the parts of its bar that fit a CLI.",
    checks: (dir) => {
      const tests = listFiles(dir).filter((f) => f.endsWith(".test.ts"));
      const cli = listFiles(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      const run = bunTest(dir);
      return [
        { label: "a CLI .ts file exists", ok: cli.length > 0, detail: cli.join(", ") },
        { label: "a .test.ts file exists", ok: tests.length > 0, detail: tests.join(", ") },
        { label: "bun test: 10+ pass, 0 fail", ok: run.pass >= 10 && run.fail === 0 && run.code === 0,
          detail: `${run.pass} pass, ${run.fail} fail` },
      ];
    },
    contents: (dir) => {
      const run = bunTest(dir);
      return `${files(dir)}; bun test ${run.pass} pass, ${run.fail} fail`;
    },
  },
  viper: {
    task: "Build viper: a canvas snake game in one index.html: grid movement on requestAnimationFrame, food, speed-up "
      + "every 5 foods, score, pause, restart, high score in localStorage. Load the design-engineering skill first and "
      + "meet the parts of its bar that fit a game.",
    checks: (dir) => {
      const html = read(dir, "index.html");
      return [
        { label: "index.html exists", ok: html !== undefined },
        { label: "uses requestAnimationFrame", ok: /requestAnimationFrame/.test(html ?? "") },
        { label: "keeps a high score in localStorage", ok: /localStorage/.test(html ?? "") },
      ];
    },
    contents: (dir) => `${files(dir)}; ${count(read(dir, "index.html") ?? "", /<canvas\b/g)} canvas`,
  },
};

const ALL = Object.keys(PROJECTS);

const SCENARIOS: Record<string, Scenario> = {
  all: { about: "build all three projects side by side, then review each in the same session", projects: ALL, phases: ["build", "review"] },
  "artisan-coffee": { about: "build and review the coffee roaster landing page", projects: ["artisan-coffee"], phases: ["build", "review"] },
  taskman: { about: "build and review the task manager CLI and its tests", projects: ["taskman"], phases: ["build", "review"] },
  viper: { about: "build and review the snake game", projects: ["viper"], phases: ["build", "review"] },
  review: { about: "one more review pass on projects already built", phases: ["review"] },
  verify: { about: "check projects already built, without calling the model", phases: [] },
};

/** Pick a scenario from argv, else ask in a terminal, else run "all". */
function choose(): string {
  const names = Object.keys(SCENARIOS);
  let pick = Bun.argv[2];
  if (!pick && process.stdin.isTTY) {
    for (const [i, name] of names.entries()) console.log(`  ${i + 1}. ${name}: ${SCENARIOS[name]?.about}`);
    pick = prompt("Run which scenario?", "1") ?? "1";
  }
  const name = names[Number(pick) - 1] ?? pick ?? "all";
  if (!(name in SCENARIOS)) {
    console.error(`Unknown scenario "${name}". Choose one of: ${names.join(", ")}`);
    process.exit(1);
  }
  return name;
}

/** The project list from argv[3], else all of them. */
function projectsFromArgs(): string[] {
  const names = Bun.argv[3]?.split(",").map((n) => n.trim()).filter(Boolean) ?? ALL;
  const unknown = names.filter((n) => !(n in PROJECTS));
  if (unknown.length) {
    console.error(`Unknown project ${unknown.join(", ")}. Choose from: ${ALL.join(", ")}`);
    process.exit(1);
  }
  return names;
}

function read(dir: string, file: string): string | undefined {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Words of visible text: comments, scripts, styles, tags, and entities stripped. */
function visibleWords(html: string): number {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ");
  return count(text, /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
}

/** Files under the project folder as relative paths, skipping the session log, the skill, and dependencies. */
function listFiles(dir: string, sub = ""): string[] {
  if (!existsSync(join(dir, sub))) return [];
  return readdirSync(join(dir, sub), { withFileTypes: true })
    .filter((e) => !["skills", "node_modules"].includes(e.name) && !e.name.startsWith("."))
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, join(sub, e.name)) : [join(sub, e.name)]))
    .sort();
}

/** The files with sizes, or a count and total size when there are more than three. */
function files(dir: string): string {
  const list = listFiles(dir);
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
  if (list.length > 3) return `${list.length} files, ${kb(list.reduce((n, f) => n + statSync(join(dir, f)).size, 0))}`;
  return list.map((f) => `${f} ${kb(statSync(join(dir, f)).size)}`).join(", ") || "(no files)";
}

/** Run bun test in the folder and read the pass and fail counts from its summary. */
function bunTest(dir: string): { code: number; pass: number; fail: number } {
  if (!existsSync(dir)) return { code: 1, pass: 0, fail: 0 };
  const run = Bun.spawnSync(["bun", "test"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const out = `${run.stdout.toString()}\n${run.stderr.toString()}`;
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
  return { code: run.exitCode ?? 1, pass: num(/^\s*(\d+) pass/m), fail: num(/^\s*(\d+) fail/m) };
}

/** Assistant lines in the project's latest session file. */
function turns(dir: string): number {
  const path = existsSync(dir) ? latest(dir) : undefined;
  if (!path) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith('{"role":"assistant"')).length;
}

/** A Harness for one project folder, printing with the project name; `resume` continues its session. */
function harnessFor(resumeSession: boolean): (workdir: string) => Harness {
  return (workdir) => {
    const name = workdir.split("/").at(-1) ?? workdir;
    const harness = new Harness({ workdir, policy: new Policy("yolo"), onEvent: eventPrinter(`[${name}]`) });
    if (resumeSession && !harness.resume()) throw new Error(`no session to resume in ${workdir}`);
    return harness;
  };
}

/** Print each fleet result with the first line of its report. */
function report(phase: string, results: FleetResult[], started: number): void {
  console.log(`\n${styleText(["bold"], `${phase} done in ${((performance.now() - started) / 1000).toFixed(0)}s`)}`);
  for (const r of results) {
    const head = r.report.split("\n").find((line) => line.trim()) ?? "";
    console.log(`  ${r.ok ? styleText("green", "ok  ") : styleText("red", "FAIL")} ${r.name}: ${head.slice(0, 140)}`);
  }
}

/** Run one phase over the projects through runFleet. */
async function phase(kind: "build" | "review", names: string[], extra: Record<string, string> = {}): Promise<void> {
  console.log(`\n${styleText(["yellow", "bold"], `== ${kind}: ${names.join(", ")}`)}`);
  const jobs = names.map((name) => {
    const workdir = join(FLEET_DIR, name);
    if (kind === "build") {
      rmSync(workdir, { recursive: true, force: true });
      mkdirSync(join(workdir, "skills", "design-engineering"), { recursive: true });
      writeFileSync(join(workdir, "skills", "design-engineering", "SKILL.md"), SKILL);
    }
    const task = kind === "build" ? (PROJECTS[name] as Project).task : `${REVIEW}${extra[name] ?? ""}`;
    return { name, workdir, task };
  });
  const started = performance.now();
  report(kind, await runFleet(jobs, harnessFor(kind === "review")), started);
}

/** Run every project's checks; return the failing ones with what failed. */
function verify(names: string[]): Record<string, string> {
  const failing: Record<string, string> = {};
  const rows: string[][] = [];
  for (const name of names) {
    const dir = join(FLEET_DIR, name);
    const checks = (PROJECTS[name] as Project).checks(dir);
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${styleText("bold", name)}`);
    for (const c of checks) {
      console.log(`  ${c.ok ? styleText("green", "pass") : styleText("red", "FAIL")} ${c.label}${c.detail ? ` (${c.detail})` : ""}`);
    }
    if (failed.length) failing[name] = ` Mechanical checks that failed: ${failed.map((c) => c.label).join("; ")}.`;
    rows.push([name, failed.length ? "fail" : "pass", String(turns(dir)), (PROJECTS[name] as Project).contents(dir)]);
  }
  console.log(`\n| project | result | turns | contents |\n| --- | --- | --- | --- |`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
  return failing;
}

const name = choose();
const scenario = SCENARIOS[name] as Scenario;
const names = scenario.projects ?? projectsFromArgs();
console.log(`\nscenario ${name}: ${scenario.about}\nfleet: ${FLEET_DIR}\nprojects: ${names.join(", ")}`);

for (const kind of scenario.phases) await phase(kind, names);
const failing = verify(names);
const retry = Object.keys(failing);
if (scenario.phases.length && retry.length) {
  console.log(`\n${styleText(["yellow", "bold"], `one more review pass for ${retry.join(", ")}`)}`);
  await phase("review", retry, failing);
  const still = Object.keys(verify(names));
  if (still.length) process.exitCode = 1;
} else if (retry.length) {
  process.exitCode = 1;
}
