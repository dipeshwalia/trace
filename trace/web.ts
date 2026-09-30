/**
 * Web logger: a live browser view of a run.
 *
 * Concept: the loop only emits events; this serves them to a local page over
 * Server-Sent Events, along with the live message history, so every turn,
 * tool call, result, and cent is visible as it happens. It can also be the
 * tool approver, turning a pending call into Approve and Deny buttons.
 *
 * Design rules: Bun built-ins only (Bun.serve, Bun.file, ReadableStream); bind
 * to localhost; buffer every event and replay it to each new connection, so a
 * page opened or reloaded mid-run sees the whole run; the page is static HTML
 * in web.html with no build step.
 */
import type { LoopEvent, Tool } from "./loop.ts";
import { DEFAULT_MODEL, type Message, type ToolCall } from "./provider.ts";

/** What the page receives: loop events plus run setup, approvals, and the outcome. */
export type WebEvent =
  | LoopEvent
  | { kind: "runStart"; system: string; model: string; tools: object[]; info: Record<string, string> }
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
        "/messages": () => Response.json(this.messages),
        "/approve/:id": { POST: (req) => this.answer(req.params.id, req) },
      },
      fetch: () => new Response("Not found", { status: 404 }),
    });
    this.url = this.server.url.href;
  }

  /**
   * Show the run's setup. Pass the same `messages` array given to runLoop so the
   * context view stays live; `info` adds labeled facts such as workdir or policy.
   */
  start({ system, messages, tools, model, info = {} }: {
    system: string; messages: Message[]; tools: Record<string, Tool>; model?: string; info?: Record<string, string>;
  }): void {
    this.messages = messages;
    const schemas = Object.values(tools).map((t) => t.spec.schema);
    this.emit({ kind: "runStart", system, model: model ?? DEFAULT_MODEL, tools: schemas, info });
  }

  /** Pass as runLoop's `onEvent` (or call from a fan-out); an arrow property so it stays bound. */
  onEvent = (event: LoopEvent): void => this.emit(event);

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
