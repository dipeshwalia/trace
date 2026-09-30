/**
 * Tools: the six core tools an agent needs to work in a directory.
 *
 * Concept: a tool is a schema plus a function. The tool() helper builds the
 * schema from a short parameter list, and coreTools() gives the model files,
 * edits, a shell, and search, all confined to one working directory.
 *
 * Design rules: Bun and Node standard library only; every path goes through
 * resolve(), which throws PermissionError outside the working directory; all
 * parameters are strings; bad input throws or returns an ERROR string, so the
 * loop can hand it back to the model.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import type { Tool } from "./loop.ts";

/** Thrown when a path leaves the working directory; the loop reports it as "ERROR: PermissionError: ...". */
export class PermissionError extends Error {
  override name = "PermissionError";
}

/** One string parameter of a tool. */
export type Param = { description: string; optional?: boolean };

/** Build a Tool whose parameters are all strings; `required` lists the non-optional ones. */
export function tool({ name, description, params, run }: {
  name: string; description: string; params: Record<string, Param>; run: Tool["run"];
}): Tool {
  const properties = Object.fromEntries(
    Object.entries(params).map(([param, p]) => [param, { type: "string", description: p.description }]));
  const required = Object.entries(params).filter(([, p]) => !p.optional).map(([param]) => param);
  return { spec: { schema: { name, description, parameters: { type: "object", properties, required } } }, run };
}

const IGNORED = new Set([".git", "node_modules", "__pycache__", ".venv"]);
const READ_LIMIT = 4000;
const OUTPUT_LIMIT = 12000;
const LIST_LIMIT = 500;
const GREP_LIMIT = 200;
const GREP_LINE = 200;

/** The six core tools, keyed by name, confined to the real path of `workdir`. */
export function coreTools(workdir: string): Record<string, Tool> {
  const root = realpathSync(workdir);

  /** Map a model-supplied path to a real path inside root, or throw PermissionError. */
  function resolve(path: unknown): string {
    const target = resolvePath(root, String(path));
    let existing = target;
    const missing: string[] = [];
    while (!existsSync(existing) && dirname(existing) !== existing) {
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
    const real = join(realpathSync(existing), ...missing);
    if (real !== root && !real.startsWith(root + sep)) {
      throw new PermissionError(`${JSON.stringify(path)} escapes the working directory`);
    }
    return real;
  }

  /** Every file under root as a root-relative path, skipping IGNORED directories. */
  async function walk(dir = root): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await walk(full));
      else if (entry.isFile()) files.push(relative(root, full));
    }
    return files;
  }

  /** Files whose relative path or base name matches the glob, sorted. */
  async function matching(pattern: unknown): Promise<string[]> {
    const glob = new Bun.Glob(String(pattern));
    return (await walk()).filter((f) => glob.match(f) || glob.match(basename(f))).sort();
  }

  const readFile = tool({
    name: "read_file",
    description: "Read a file; lines are numbered as N<TAB>line",
    params: { path: { description: "File path, relative to the working directory" } },
    run: async ({ path }) => {
      const text = await Bun.file(resolve(path)).text();
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      const numbered = lines.slice(0, READ_LIMIT).map((line, i) => `${i + 1}\t${line}`);
      if (lines.length > READ_LIMIT) numbered.push(`... truncated: the file has ${lines.length} lines`);
      return numbered.join("\n");
    },
  });

  const writeFile = tool({
    name: "write_file",
    description: "Create or overwrite a file, creating parent directories",
    params: {
      path: { description: "File path, relative to the working directory" },
      content: { description: "The full file contents" },
    },
    run: async ({ path, content }) => {
      const target = resolve(path);
      const text = String(content);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, text);
      return `Wrote ${text.length} chars to ${path}`;
    },
  });

  const editFile = tool({
    name: "edit_file",
    description: "Replace one exact snippet in a file; the snippet must appear exactly once",
    params: {
      path: { description: "File path, relative to the working directory" },
      old: { description: "The exact text to replace, copied from the file" },
      new: { description: "The replacement text" },
    },
    run: async ({ path, old, new: replacement }) => {
      const target = resolve(path);
      const text = await Bun.file(target).text();
      const snippet = String(old);
      const count = snippet ? text.split(snippet).length - 1 : 0;
      if (count === 0) return "ERROR: snippet not found — read the file and copy it exactly";
      if (count > 1) return `ERROR: snippet appears ${count} times — include more context to make it unique`;
      // A function replacement keeps "$&" and similar patterns in the new text literal.
      await Bun.write(target, text.replace(snippet, () => String(replacement)));
      return `Edited ${path}`;
    },
  });

  const bash = tool({
    name: "bash",
    description: "Run a shell command in the working directory; returns stdout and stderr combined",
    params: {
      command: { description: "The shell command" },
      timeout: { description: "Seconds before the command is killed (default 120)", optional: true },
    },
    run: ({ command, timeout }) => new Promise<string>((done) => {
      const seconds = Number(timeout ?? 120) || 120;
      // detached puts sh in its own process group, so a timeout can kill its children too.
      const child = spawn("sh", ["-c", String(command)], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let timedOut = false;
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => { output += chunk; });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      }, seconds * 1000);
      child.on("error", (err) => {
        clearTimeout(timer);
        done(`ERROR: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return done(`ERROR: timed out after ${seconds}s`);
        if (!output) return done(`(exit ${code}, no output)`);
        if (output.length <= OUTPUT_LIMIT) return done(output);
        const half = OUTPUT_LIMIT / 2;
        done(`${output.slice(0, half)}\n... [${output.length - OUTPUT_LIMIT} chars truncated] ...\n${output.slice(-half)}`);
      });
    }),
  });

  const listFiles = tool({
    name: "list_files",
    description: "List files matching a glob, matched against the relative path and the base name",
    params: { pattern: { description: 'Glob pattern (default "**/*")', optional: true } },
    run: async ({ pattern }) => {
      const files = await matching(pattern ?? "**/*");
      const shown = files.slice(0, LIST_LIMIT);
      if (files.length > LIST_LIMIT) shown.push(`and ${files.length - LIST_LIMIT} more`);
      return shown.join("\n") || "(no files match)";
    },
  });

  const grep = tool({
    name: "grep",
    description: "Search file contents with a regex; results are path:lineno: text",
    params: {
      regex: { description: "JavaScript regular expression" },
      pattern: { description: 'Glob for which files to search (default "*")', optional: true },
    },
    run: async ({ regex, pattern }) => {
      const re = new RegExp(String(regex));
      const hits: string[] = [];
      for (const file of await matching(pattern ?? "*")) {
        const text = await Bun.file(join(root, file)).text();
        if (text.includes("\0")) continue;
        for (const [i, line] of text.split("\n").entries()) {
          if (!re.test(line)) continue;
          hits.push(`${file}:${i + 1}: ${line.slice(0, GREP_LINE)}`);
          if (hits.length >= GREP_LIMIT) return hits.join("\n");
        }
      }
      return hits.join("\n") || "(no matches)";
    },
  });

  return Object.fromEntries(
    [readFile, writeFile, editFile, bash, listFiles, grep].map((t) => [t.spec.schema.name, t]));
}
