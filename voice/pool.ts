// How many subagents may run at once.
//
// Not a stylistic limit. Each concurrent subagent is a Claude conversation
// burning tokens, an MCP server holding memory, a tmux window, and a share of
// a machine that is already at 90% disk. Five parallel jobs are five times the
// burn rate, and an unbounded fan-out is a bill and a swap storm arriving
// together.
//
// The cap QUEUES rather than refuses. Ten papers with a cap of four is three
// waves, which is still most of the speedup and needs no special handling from
// the master -- it hands over ten tasks and gets ten results. Refusing the
// eleventh would push the batching problem up into a prompt, which is exactly
// where it would be got wrong.
//
// HARD_MAX exists because the limit is a resource fact, not a preference. A
// setting can raise the default; nothing can raise this.

const HARD_MAX = 8
const DEFAULT_LIMIT = 4

export function concurrencyLimit(configured?: number): number {
  const n = Number(configured)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), HARD_MAX)
}

export { HARD_MAX, DEFAULT_LIMIT }

/**
 * Run `jobs` with at most `limit` in flight, preserving input order in the
 * results.
 *
 * Order matters more than it looks: the master joins these, and a join that
 * has to work out which result belongs to which task is a join that will
 * eventually pair the wrong two. Slot i in, slot i out.
 *
 * A job that throws resolves to its error rather than rejecting the batch. Two
 * failures out of five must still leave three usable results and a master that
 * can say which two failed -- a partial answer reported honestly beats an
 * exception that discards the work that succeeded.
 */
export async function runPool<T, R>(
  jobs: T[],
  limit: number,
  run: (job: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: string }>(jobs.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= jobs.length) return
      try {
        results[i] = { ok: true, value: await run(jobs[i], i) }
      } catch (e) {
        results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return results
}
