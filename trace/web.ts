/**
 * Web logger: a live browser view of a run.
 *
 * Concept: the loop only emits events; this serves them to a local page over
 * Server-Sent Events, along with the live message history, project memory, and
 * skill catalog, so every turn, tool call, compaction, and cent is visible as
 * it happens. It can also be the tool approver, turning a pending call into
 * Approve and Deny buttons.
 *
 * Design rules: Bun built-ins only (Bun.serve, Bun.file, ReadableStream); bind
 * to localhost; buffer every event and replay it to each new connection, so a
 * page opened or reloaded mid-run sees the whole run; memory and skills are
 * re-read from disk on each /live request, so edits during the run show up;
 * the page is static HTML in web.html with no build step.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./context.ts";
import type { LoopEvent, LoopOptions, Tool } from "./loop.ts";
import { MEMORY_FILE } from "./memory.ts";
import { DEFAULT_MODEL, type Message, type ToolCall } from "./provider.ts";
import { type Guard, guardOf } from "./security.ts";
import { catalog } from "./skills.ts";

/** Size of a message list: its length and estimated tokens. */
export type ContextSize = { messages: number; tokens: number };

/** What the page receives: loop events (tool results tagged with the guard that stopped them) plus run setup, context, approvals, and the outcome. */
export type WebEvent =
  | Exclude<LoopEvent, { kind: "toolEnd" }>
  | (Extract<LoopEvent, { kind: "toolEnd" }> & { guard?: Guard })
  | { kind: "runStart"; system: string; model: string; tools: object[]; info: Record<string, string>; budget?: number }
  | ({ kind: "context" } & ContextSize)
  | { kind: "compacted"; before: ContextSize; after: ContextSize; summary: string }
  | { kind: "approval"; call: ToolCall; reason: string }
  | { kind: "approved"; id: string; allow: boolean }
  | { kind: "final"; answer: string }
  | { kind: "failed"; error: string };

const PAGE = new URL("./web.html", import.meta.url);
const encoder = new TextEncoder();
type Client = ReadableStreamDefaultController<Uint8Array>;

/** Serves a live view of one run at `url`; the server stays up until stop(). */
export class WebLogger {
  /** Address of the page, e.g. http://127.0.0.1:53811/. */
  readonly url: string;
  private server: ReturnType<typeof Bun.serve>;
  private frames: string[] = [];
  private clients = new Set<Client>();
  private pending = new Map<string, (allow: boolean) => void>();
  private messages: Message[] = [];
  private workdir: string | undefined;

  /** Start the server on `port`; 0 (the default, or TRACE_UI_PORT) picks a free one. */
  constructor(port = Number(Bun.env.TRACE_UI_PORT ?? 0)) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      // Event streams sit idle between turns; Bun's default 10s timeout would cut them.
      idleTimeout: 0,
      routes: {
        "/": () => new Response(Bun.file(PAGE)),
        "/events": () => this.stream(),
        "/live": () => Response.json(this.live()),
        "/approve/:id": { POST: (req) => this.answer(req.params.id, req) },
      },
      fetch: () => new Response("Not found", { status: 404 }),
    });
    this.url = this.server.url.href;
  }

  /**
   * Show the run's setup. Pass the same `messages` array given to runLoop so the
   * context view stays live; `info` adds labeled facts such as policy; `workdir`
   * turns on the memory and skills panels; `budget` is the compaction budget in tokens.
   */
  start({ system, messages, tools, model, info = {}, workdir, budget }: {
    system: string; messages: Message[]; tools: Record<string, Tool>; model?: string;
    info?: Record<string, string>; workdir?: string; budget?: number;
  }): void {
    this.messages = messages;
    this.workdir = workdir;
    const schemas = Object.values(tools).map((t) => t.spec.schema);
    const facts = workdir ? { workdir, ...info } : info;
    this.emit({ kind: "runStart", system, model: model ?? DEFAULT_MODEL, tools: schemas, info: facts, budget });
  }

  /** Pass as runLoop's `onEvent` (or call from a fan-out); an arrow property so it stays bound. */
  onEvent = (event: LoopEvent): void =>
    this.emit(event.kind === "toolEnd" ? { ...event, guard: guardOf(event.call, event.result) } : event);

  /**
   * Wrap runLoop's beforeTurn so the page shows the context size before every
   * turn and each compaction with its summary. With no hook, only sizes are shown.
   */
  beforeTurn(hook?: LoopOptions["beforeTurn"]): NonNullable<LoopOptions["beforeTurn"]> {
    return async (messages) => {
      const before = { messages: messages.length, tokens: estimateTokens(messages) };
      this.emit({ kind: "context", ...before });
      const kept = hook ? await hook(messages) : messages;
      if (kept !== messages) {
        const after = { messages: kept.length, tokens: estimateTokens(kept) };
        this.emit({ kind: "compacted", before, after, summary: kept[0]?.role === "user" ? kept[0].text : "" });
      }
      return kept;
    };
  }

  /** Ask on the page whether `call` may run; resolves when Approve or Deny is clicked. Fits Policy's approver. */
  approver = (call: ToolCall, reason: string): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.pending.set(call.id, resolve);
    this.emit({ kind: "approval", call, reason });
    return promise;
  };

  /** Show the final answer and the run summary. */
  final(answer: string): void {
    this.emit({ kind: "final", answer });
  }

  /** Show that the run crashed, with the error message. */
  fail(err: unknown): void {
    this.emit({ kind: "failed", error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }

  /** Deny any pending approvals and shut the server down. */
  stop(): void {
    for (const resolve of this.pending.values()) resolve(false);
    this.pending.clear();
    this.server.stop(true);
  }

  /** The live history and its size, plus the memory file and skill catalog as they are on disk now. */
  private live(): object {
    const workdir = this.workdir;
    const memoryPath = workdir && join(workdir, MEMORY_FILE);
    return {
      messages: this.messages,
      tokens: estimateTokens(this.messages),
      memory: memoryPath && existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : null,
      skills: workdir ? Object.entries(catalog(workdir)).map(([name, s]) => ({ name, description: s.description })) : null,
    };
  }

  private emit(event: WebEvent): void {
    const frame = `data: ${JSON.stringify({ at: Date.now(), event })}\n\n`;
    this.frames.push(frame);
    const bytes = encoder.encode(frame);
    for (const client of this.clients) {
      try {
        client.enqueue(bytes);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private stream(): Response {
    let self: Client | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (client) => {
        self = client;
        client.enqueue(encoder.encode(this.frames.join("")));
        this.clients.add(client);
      },
      cancel: () => {
        if (self) this.clients.delete(self);
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  private async answer(id: string, req: Request): Promise<Response> {
    // Any site can POST text/plain to localhost without a preflight; JSON needs one we never grant.
    if (!req.headers.get("content-type")?.startsWith("application/json")) return new Response("Expected JSON", { status: 415 });
    const resolve = this.pending.get(id);
    if (!resolve) return new Response("No pending approval", { status: 404 });
    const { allow } = (await req.json()) as { allow?: unknown };
    this.pending.delete(id);
    this.emit({ kind: "approved", id, allow: allow === true });
    resolve(allow === true);
    return new Response(null, { status: 204 });
  }
}
