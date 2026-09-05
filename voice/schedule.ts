// Things the agent should do later, or again.
//
// systemd user timers rather than cron, and not only because cron is not
// installed here. A timer survives a reboot, records why it fired in the
// journal, can be listed and cancelled by name, and is already how the voice
// daemon runs -- one supervision story instead of two. `Persistent=true` also
// catches up a job whose moment passed while the machine was asleep, which is
// most mornings on a laptop.
//
// Two kinds, because they carry different risk:
//
//   one-off     fires once and removes itself. Cannot be forgotten, because
//               it stops existing.
//   recurrent   runs until cancelled, which is the useful part and the
//               dangerous part. It carries an expiry so a job nobody
//               remembers creating cannot still be running next year.
//
// Every job is a file this code wrote, listed by `desktop-agent jobs` and
// cancellable by name. A schedule that can only be found with systemctl is a
// schedule its owner has lost.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const HOME = process.env.HOME!
const JOBS = `${HOME}/.local/state/desktop-agent/jobs`
const UNIT_PREFIX = "desktop-agent-job-"

export type JobKind = "reminder" | "task"

export interface Job {
  id: string
  kind: JobKind
  /** What to say (reminder) or do (task). */
  text: string
  /** systemd OnCalendar expression, or an ISO instant for a one-off. */
  when: string
  recurrent: boolean
  createdAt: number
  /** Recurrent jobs stop here unless renewed. 0 for one-offs. */
  expiresAt: number
  /**
   * What a task may do when it runs with nobody watching.
   *
   * Declared at creation and approved once, so the job never has to ask at
   * 3am -- and never grows either: anything outside this list is refused
   * rather than queued for an answer nobody is awake to give.
   */
  capabilities: string[]
}

function id(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 4)}`
}

export function jobsDir(): string {
  mkdirSync(JOBS, { recursive: true })
  return JOBS
}

export function listJobs(): Job[] {
  try {
    return readdirSync(jobsDir())
      .filter(f => f.endsWith(".json"))
      .map(f => { try { return JSON.parse(readFileSync(`${JOBS}/${f}`, "utf8")) as Job } catch { return null } })
      .filter((j): j is Job => !!j && typeof j.id === "string")
      .sort((a, b) => a.createdAt - b.createdAt)
  } catch { return [] }
}

/** Remove a job and its timer. Returns whether there was one. */
export function cancelJob(jobId: string): boolean {
  const found = listJobs().some(j => j.id === jobId)
  const unit = `${UNIT_PREFIX}${jobId}`
  // Timer first: stopping after deleting the file would leave a timer whose
  // job no longer exists, which fires and finds nothing.
  Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.timer`])
  Bun.spawnSync(["systemctl", "--user", "stop", `${unit}.service`])
  Bun.spawnSync(["systemctl", "--user", "reset-failed", `${unit}.timer`])
  Bun.spawnSync(["systemctl", "--user", "reset-failed", `${unit}.service`])
  try { rmSync(`${JOBS}/${jobId}.json`, { force: true }) } catch {}
  return found
}

/** Drop jobs whose expiry has passed, and one-offs that already fired. */
export function pruneJobs(): number {
  let gone = 0
  for (const j of listJobs()) {
    const expired = j.expiresAt > 0 && Date.now() > j.expiresAt
    if (!expired) continue
    cancelJob(j.id)
    gone++
  }
  return gone
}

export interface CreateResult { ok: boolean; job?: Job; error?: string }

/**
 * Create a job and its timer.
 *
 * `when` is a systemd calendar expression ("tomorrow 09:00", "Mon..Fri 08:30",
 * "*-*-* 07:00:00") for anything recurrent, and an instant for a one-off.
 * systemd parses it, so an invalid expression is rejected here rather than
 * silently never firing -- the failure mode a scheduler must not have.
 */
export function createJob(
  spec: { kind: JobKind; text: string; when: string; recurrent: boolean; capabilities?: string[]; expiryDays?: number },
): CreateResult {
  const jobId = id()
  const unit = `${UNIT_PREFIX}${jobId}`

  // Validated before anything is written. A job that cannot fire is worse than
  // a rejected one: it looks scheduled.
  const check = Bun.spawnSync(["systemd-analyze", "calendar", spec.when])
  if (check.exitCode !== 0) {
    const msg = new TextDecoder().decode(check.stderr).trim().split("\n")[0]
    return { ok: false, error: `"${spec.when}" is not a time systemd understands (${msg || "unparseable"})` }
  }

  const days = spec.recurrent ? (spec.expiryDays ?? 90) : 0
  const job: Job = {
    id: jobId,
    kind: spec.kind,
    text: spec.text,
    when: spec.when,
    recurrent: spec.recurrent,
    createdAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400_000 : 0,
    capabilities: spec.capabilities ?? [],
  }

  try {
    mkdirSync(JOBS, { recursive: true })
    writeFileSync(`${JOBS}/${jobId}.json`, JSON.stringify(job, null, 2))
  } catch (e) {
    return { ok: false, error: `could not save the job: ${e}` }
  }

  const runner = new URL("./runjob.ts", import.meta.url).pathname
  const bun = Bun.which("bun")
  if (!bun) { cancelJob(jobId); return { ok: false, error: "bun is not on PATH" } }

  const args = [
    "systemd-run", "--user",
    `--unit=${unit}`,
    `--on-calendar=${spec.when}`,
    "--timer-property=Persistent=true",
    `--description=Desktop Agent: ${spec.text.slice(0, 60)}`,
  ]
  // A one-off removes itself once it has fired. Nothing to forget, nothing to
  // clean up later, and no way for it to run twice.
  if (!spec.recurrent) args.push("--timer-property=RemainAfterElapse=false")
  // The timer outlives the plugin unless it is taught not to.
  //
  // Omarchy runs no uninstall hook, so deleting the plugin directory leaves
  // these units behind: they fire on schedule, fail because the runner is
  // gone, and keep failing on schedule for as long as the machine exists.
  // Rather than depend on a hook that does not exist, each job checks that its
  // runner is still there and removes ITSELF if it is not. The first firing
  // after an uninstall is the last one.
  const selfHeal =
    `test -f ${runner} || { ` +
    `systemctl --user stop ${unit}.timer >/dev/null 2>&1; ` +
    `rm -f ${JOBS}/${jobId}.json; exit 0; }; ` +
    `exec ${bun} run ${runner} ${jobId}`
  args.push("/bin/sh", "-c", selfHeal)

  const made = Bun.spawnSync(args)
  if (made.exitCode !== 0) {
    const msg = new TextDecoder().decode(made.stderr).trim().split("\n").pop()
    cancelJob(jobId)
    return { ok: false, error: `systemd refused the timer: ${msg}` }
  }
  return { ok: true, job }
}

/** When each timer will next fire, keyed by job id. */
export function nextRuns(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const p = Bun.spawnSync(["systemctl", "--user", "list-timers", "--all", "--no-pager", "--no-legend"])
    for (const line of new TextDecoder().decode(p.stdout).split("\n")) {
      const m = line.match(new RegExp(`(\\\\S.*?)\\\\s+\\\\S+\\\\s+.*?${UNIT_PREFIX}([a-z0-9-]+)\\\\.timer`))
      if (m) out[m[2]] = m[1].trim()
    }
  } catch {}
  return out
}

export { UNIT_PREFIX }
