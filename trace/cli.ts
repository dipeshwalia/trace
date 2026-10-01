/**
 * Command line entry point, run as `bun run trace`.
 *
 * Concept: the CLI will drive a Harness from the terminal. It is a stub until
 * step 6 completes it; for now it points at the harness demo.
 *
 * Design rules: Bun and Node standard library only; main() is exported so
 * tests can call it, and runs on its own only when this file is the entry.
 */

/** Print that the CLI is not built yet and exit nonzero. */
export async function main(): Promise<void> {
  console.error("trace: the command line arrives in step 6. Until then, try `bun demos/4-harness.ts`.");
  process.exitCode = 1;
}

if (import.meta.main) await main();
