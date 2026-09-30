/**
 * Security: the policy that decides whether a tool call may run.
 *
 * Concept: the loop asks beforeTool about every call. A Policy answers with
 * nothing (allow) or a reason (block), and the loop hands that reason back to
 * the model as a BLOCKED result.
 *
 * Design rules: standard library only; dangerous shell commands are blocked
 * in every mode, before anything else; read tools are always allowed; the
 * default approver refuses, so safe mode fails closed.
 */
import type { ToolCall } from "./provider.ts";

/** Tools that only read, allowed in every mode. */
export const READ_TOOLS = new Set(["read_file", "list_files", "grep"]);

const HOME_OR_ROOT = String.raw`["']?(?:/|~/?|\$HOME/?|\$\{HOME\}/?)\*?["']?(?=\s|$|[;&|])`;

/** Bash commands that are blocked in every mode, including yolo. */
export const DENY_PATTERNS: RegExp[] = [
  // rm with both recursive and force flags, in any spelling, aimed at /, ~, or $HOME.
  new RegExp(String.raw`\brm\s+(?=(?:[^;&|]*\s)?-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b)`
    + String.raw`(?=(?:[^;&|]*\s)?-(?:[a-zA-Z]*f[a-zA-Z]*|-force)\b)[^;&|]*?\s${HOME_OR_ROOT}`),
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\b[^;&|]*\bif=/,
  /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
  /\bgit\s+push\b[^;&|]*\s(?:--force(?:-with-lease)?|-f)\b/,
  />\s*\/dev\/sd[a-z]/,
];

/** read-only allows only READ_TOOLS; safe asks the approver for the rest; yolo allows everything not denied. */
export type Mode = "read-only" | "safe" | "yolo";

/** Asked in safe mode; return true to allow the call. */
export type Approver = (call: ToolCall, reason: string) => boolean | Promise<boolean>;

/** Decides each tool call; pass `check` as runLoop's beforeTool. */
export class Policy {
  constructor(readonly mode: Mode = "safe", private readonly approver: Approver = () => false) {}

  /** Return undefined to allow the call, or the reason it is blocked. An arrow property so it stays bound. */
  check = async (call: ToolCall): Promise<string | undefined> => {
    if (call.name === "bash") {
      const command = String(call.args.command ?? "");
      if (DENY_PATTERNS.some((pattern) => pattern.test(command))) return `${JSON.stringify(command)} matches a denied pattern`;
    }
    if (READ_TOOLS.has(call.name) || this.mode === "yolo") return undefined;
    if (this.mode === "read-only") return `read-only mode does not allow ${call.name}`;
    const reason = `${call.name} needs approval in safe mode`;
    return (await this.approver(call, reason)) ? undefined : `not approved: ${reason}`;
  };
}
