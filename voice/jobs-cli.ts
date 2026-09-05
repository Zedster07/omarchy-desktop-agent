#!/usr/bin/env bun
// Listing and cancelling schedules from a terminal.

import { listJobs, cancelJob, pruneJobs, nextRuns, createJob, normaliseWhen } from "./schedule.ts"

const cmd = process.argv[2] ?? "list"

if (cmd === "list") {
  const dropped = pruneJobs()
  const jobs = listJobs()
  const next = nextRuns()
  if (!jobs.length) {
    console.log("  nothing scheduled" + (dropped ? `  (${dropped} expired job(s) removed)` : ""))
    process.exit(0)
  }
  console.log(`  ${jobs.length} scheduled${dropped ? `, ${dropped} expired removed` : ""}\n`)
  for (const j of jobs) {
    const kind = j.kind === "reminder" ? "reminder" : "task"
    const rep = j.recurrent ? "repeats" : "once"
    console.log(`  ${j.id}  ${kind.padEnd(8)} ${rep.padEnd(7)} ${j.when}`)
    console.log(`      ${j.text.slice(0, 76)}`)
    if (j.kind === "task" && j.capabilities.length) {
      console.log(`      may: ${j.capabilities.join(", ")}`)
    }
    if (next[j.id]) console.log(`      next: ${next[j.id]}`)
    if (j.expiresAt) console.log(`      expires: ${new Date(j.expiresAt).toISOString().slice(0, 10)}`)
    console.log()
  }
  process.exit(0)
}

if (cmd === "cancel") {
  const target = process.argv[3]
  if (target === "all") {
    const all = listJobs()
    for (const j of all) cancelJob(j.id)
    console.log(`  cancelled ${all.length}`)
    process.exit(0)
  }
  console.log(cancelJob(target!) ? `  cancelled ${target}` : `  no job called ${target}`)
  process.exit(0)
}

if (cmd === "list-json") {
  // One line of JSON, for the panel. Kept separate from `list` so the human
  // format can stay readable without something parsing it.
  pruneJobs()
  const next = nextRuns()
  console.log(JSON.stringify(listJobs().map(j => ({
    id: j.id, kind: j.kind, text: j.text, when: j.when,
    recurrent: j.recurrent, capabilities: j.capabilities,
    next: next[j.id] ?? "", expiresAt: j.expiresAt,
  }))))
  process.exit(0)
}

if (cmd === "remind") {
  const when = process.argv[3]
  const text = process.argv.slice(4).join(" ")
  if (!when || !text) { console.error('usage: jobs-cli.ts remind "<when>" "<text>"'); process.exit(2) }
  // Ask systemd whether it repeats, rather than guessing from the spelling.
  //
  // A regex on the first character got "Mon..Fri" right and "09:00" wrong --
  // and "09:00" means *-*-* 09:00:00, every day. It was stored as a one-off,
  // so it deleted its own record after the first morning and never fired
  // again, which is the sort of failure nobody reports because it looks like
  // they must have set it up wrong.
  const it = Bun.spawnSync(["systemd-analyze", "calendar", "--iterations=2", normaliseWhen(when)])
  const fires = (new TextDecoder().decode(it.stdout).match(/Next elapse|Iter/g) ?? []).length
  const repeats = fires > 1 || /Next elapse[\s\S]*Next elapse/.test(new TextDecoder().decode(it.stdout))
  const r = createJob({ kind: "reminder", text, when, recurrent: repeats })
  if (!r.ok) { console.error(`  ${r.error}`); process.exit(1) }
  console.log(`  reminder set for ${when} (${r.job!.id})`)
  process.exit(0)
}

console.error("usage: jobs-cli.ts list | cancel <id|all> | remind <when> <text>")
process.exit(2)
