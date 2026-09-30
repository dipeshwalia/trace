/**
 * Skills: instructions the agent loads on demand.
 *
 * Concept: a skill is a folder skills/<name>/ holding a SKILL.md. The system
 * prompt lists each skill's one-line description, and the model pulls in the
 * full text with the use_skill tool only when it is relevant.
 *
 * Design rules: Node standard library only; the description comes from a
 * "description:" line in the front matter, when present; a skill is looked
 * up by name in the catalog, never by a model-supplied path.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./loop.ts";
import { tool } from "./tools.ts";

export const SKILLS_DIR = "skills";

export type Skill = { description: string; path: string };

/** Every workdir/skills/<name>/SKILL.md, keyed by name. */
export function catalog(workdir: string): Record<string, Skill> {
  const dir = join(workdir, SKILLS_DIR);
  if (!existsSync(dir)) return {};
  const skills: Record<string, Skill> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(path)) continue;
    skills[entry.name] = { description: frontMatterDescription(readFileSync(path, "utf8")), path };
  }
  return skills;
}

/** The skill list for the system prompt, or "" when there are none. */
export function catalogPrompt(workdir: string): string {
  const lines = Object.entries(catalog(workdir)).map(([name, s]) => `- ${name}: ${s.description}`);
  if (!lines.length) return "";
  return ["Skills available (load one with the use_skill tool when relevant):", ...lines].join("\n");
}

/** The full SKILL.md text, or an ERROR naming the available skills. */
export function readSkill(workdir: string, name: string): string {
  const skills = catalog(workdir);
  const skill = skills[name];
  if (!skill) return `ERROR: no skill named ${name}. Available: ${Object.keys(skills).join(", ") || "(none)"}`;
  return readFileSync(skill.path, "utf8");
}

/** The use_skill tool, which returns a skill's full instructions. */
export function useSkillTool(workdir: string): Tool {
  return tool({
    name: "use_skill",
    description: "Load the full instructions of a skill listed in the system prompt",
    params: { name: { description: "The skill name" } },
    run: ({ name }) => readSkill(workdir, String(name)),
  });
}

function frontMatterDescription(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return /^description:\s*(.*)$/m.exec(match?.[1] ?? "")?.[1]?.trim() ?? "";
}
