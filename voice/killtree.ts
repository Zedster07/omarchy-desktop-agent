// Kill a process and everything it started.
//
// stopAgent held one handle and killed one process. That was right while a
// hand-off WAS one process. The moment a master can spawn subagents, killing
// it orphans them: the master dies, the HUD says stopped, and five confined
// agents carry on driving the desktop with a live lease behind them. The stop
// button would have become a lie at exactly the moment it mattered most.
//
// Depth-first, children before parents. Killing the parent first reparents its
// children to init, and a process reparented to init cannot be found by asking
// who its parent was -- the tree is gone before it has been walked.

/** Direct children of a pid, via /proc. */
function childrenOf(pid: number): number[] {
  try {
    const p = Bun.spawnSync(["pgrep", "-P", String(pid)])
    return new TextDecoder().decode(p.stdout).split("\n")
      .map(l => Number(l.trim())).filter(n => Number.isInteger(n) && n > 0)
  } catch { return [] }
}

/** Every descendant of a pid, deepest first. */
export function descendants(pid: number, depth = 0): number[] {
  // A cycle is impossible in a process tree, but a runaway depth would mean
  // something is very wrong, and looping forever while trying to stop things
  // is the wrong way to be wrong.
  if (depth > 12) return []
  const kids = childrenOf(pid)
  return kids.flatMap(k => [...descendants(k, depth + 1), k])
}

/**
 * Kill `pid` and everything under it.
 *
 * SIGTERM first so a child can flush and exit tidily -- an MCP server killed
 * mid-write leaves the marker files this project has already had to sweep up.
 * SIGKILL after the grace period for whatever ignored it.
 */
export function killTree(pid: number, graceMs = 1200): void {
  const tree = [...descendants(pid), pid]
  for (const p of tree) { try { process.kill(p, "SIGTERM") } catch {} }
  setTimeout(() => {
    for (const p of tree) { try { process.kill(p, "SIGKILL") } catch {} }
  }, graceMs)
}
