/**
 * Fleet: run many independent tasks at once, one Harness each.
 *
 * Concept: separate projects share nothing, so they can run side by side.
 * runFleet() keeps a fixed number of jobs in flight, gives each its own
 * Harness and working directory, and collects one result per job.
 *
 * Design rules: standard library only; a promise pool, not threads, since a
 * run spends its time waiting on the model and on tools; a failing job
 * becomes a result and never stops the others; results come back in input
 * order.
 */
import type { Harness } from "./harness.ts";

/** One task to run in its own working directory. */
export type FleetJob = { name: string; workdir: string; task: string };

/** A job's outcome: the final answer, or "<error name>: <message>" when it threw. */
export type FleetResult = { name: string; ok: boolean; report: string };

/** Run every job through makeHarness(workdir).run(task), at most maxWorkers at a time; results are in input order. */
export async function runFleet(
  jobs: FleetJob[], makeHarness: (workdir: string) => Harness, maxWorkers = 4,
): Promise<FleetResult[]> {
  const results: FleetResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await runJob(jobs[index] as FleetJob, makeHarness);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(maxWorkers, jobs.length)) }, worker));
  return results;
}

async function runJob({ name, workdir, task }: FleetJob, makeHarness: (workdir: string) => Harness): Promise<FleetResult> {
  try {
    return { name, ok: true, report: await makeHarness(workdir).run(task) };
  } catch (err) {
    const report = err instanceof Error ? `${err.name}: ${err.message}` : `Error: ${String(err)}`;
    return { name, ok: false, report };
  }
}
