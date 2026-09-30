/**
 * Console logger for loop events.
 *
 * Concept: the loop only emits events; this turns them into a readable,
 * colored transcript with a live spinner while the model or a tool is working,
 * and a per-turn and per-model usage report.
 *
 * Design rules: standard library only (node:util styleText); output is plain
 * when stdout is not a terminal or NO_COLOR is set, and the spinner then
 * becomes a single status line.
 */
import { styleText } from "node:util";
import type { LoopEvent, Meter } from "./loop.ts";

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const usd = (n: number) => `$${n.toFixed(6)}`;

export class ConsoleLogger {
  private meter: Meter | undefined;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private toolRuns: Record<string, { calls: number; failed: number }> = {};

  /** Pass as runLoop's `onEvent`; an arrow property so it stays bound. */
  onEvent = (event: LoopEvent): void => {
    this.stop();
    switch (event.kind) {
      case "modelStart":
        this.spin(`turn ${event.turn}: waiting for model`);
        break;
      case "assistant": {
        const { text, usage } = event.completion;
        this.meter = event.meter;
        const { turn, total } = event.meter;
        if (text) console.log(`${styleText(["magenta", "bold"], "assistant:")} ${text}`);
        console.log(styleText("dim", `[turn ${turn}] in ${usage.input} out ${usage.output} ${usd(usage.cost)}`
          + ` | run in ${total.input} out ${total.output} ${usd(total.cost)}`));
        break;
      }
      case "toolStart":
        console.log(styleText("cyan", `-> ${event.call.name} ${JSON.stringify(event.call.args)}`));
        this.spin(`running ${event.call.name}`);
        break;
      case "toolEnd": {
        const failed = /^(ERROR|BLOCKED):/.test(event.result);
        const runs = this.toolRuns[event.call.name] ?? { calls: 0, failed: 0 };
        this.toolRuns[event.call.name] = runs;
        runs.calls++;
        if (failed) runs.failed++;
        console.log(styleText(failed ? "red" : "green", `<- ${event.result}`));
        break;
      }
    }
  };

  /** Print the final answer, tool calls per tool, then usage, cost, and effective $/M tokens per model. */
  final(answer: string): void {
    this.stop();
    console.log(`\n${styleText(["green", "bold"], "final:")} ${answer}`);
    const tools = Object.entries(this.toolRuns);
    const calls = tools.reduce((n, [, r]) => n + r.calls, 0);
    const detail = tools.map(([name, r]) => `${name} ×${r.calls}${r.failed ? ` (${r.failed} failed)` : ""}`);
    console.log(`${styleText("cyan", "tools:")} ${calls} call${calls === 1 ? "" : "s"}`
      + (detail.length ? `: ${detail.join(", ")}` : ""));
    for (const [model, u] of Object.entries(this.meter?.byModel ?? {})) {
      const tokens = u.input + u.output;
      const rate = tokens ? ` (effective $${(u.cost / tokens * 1e6).toFixed(2)}/M tokens)` : "";
      console.log(`${styleText("yellow", model)}: in ${u.input} out ${u.output} ${usd(u.cost)}${rate}`);
    }
  }

  /** Clear the spinner. Call on failure too, or its timer keeps the process alive. */
  stop(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    process.stdout.write("\r\x1b[2K");
  }

  private spin(label: string): void {
    if (!process.stdout.isTTY) {
      console.log(styleText("dim", `… ${label}`));
      return;
    }
    const started = performance.now();
    let frame = 0;
    this.spinner = setInterval(() => {
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      const glyph = FRAMES[frame++ % FRAMES.length] ?? "";
      process.stdout.write(`\r${styleText("yellow", glyph)} ${styleText("dim", `${label} ${secs}s`)}`);
    }, 80);
  }
}
