#!/usr/bin/env bun
// What a timer actually runs.
//
// Kept separate from the daemon on purpose: a job fires whether or not anyone
// is logged into a shell, and its failures belong in the journal next to the
// unit that caused them rather than in a log the daemon happens to own.
//
// A reminder is a notification and nothing else -- no agent, no tools, no
// policy questions. Most of what people want from scheduling is this, and it
// is worth keeping it that simple rather than routing it through machinery
// built for something harder.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { handOff } from "./agent.ts"
import { remember } from "./history.ts"
import type { Job } from "./schedule.ts"

const HOME = process.env.HOME!
const JOBS = `${HOME}/.local/state/desktop-agent/jobs`

function notify(title: string, body: string, urgency = "normal"): void {
  try {
    Bun.spawnSync(["notify-send", "-a", "Desktop Agent", "-u", urgency, title, body])
  } catch {}
}

const jobId = process.argv[2]
if (!jobId) { console.error("usage: runjob.ts <job-id>"); process.exit(2) }

let job: Job
try {
  job = JSON.parse(readFileSync(`${JOBS}/${jobId}.json`, "utf8"))
} catch {
  // The job was cancelled between the timer firing and this running. Nothing
  // to do and nothing to complain about.
  process.exit(0)
}

if (job.expiresAt > 0 && Date.now() > job.expiresAt) {
  notify("Reminder expired", `"${job.text}" was scheduled to repeat but its 90 days are up. Recreate it if you still want it.`)
  process.exit(0)
}

if (job.kind === "reminder") {
  notify("Reminder", job.text, "critical")
  if (!job.recurrent) { try { unlinkSync(`${JOBS}/${jobId}.json`) } catch {} }
  process.exit(0)
}

// ---- a scheduled task: a real hand-off, with nobody watching.
//
// The capability list travels with the run. It was approved when the job was
// created, so the agent does not stop to ask at 3am -- and cannot widen: the
// server refuses anything outside the list rather than queueing a question no
// one is awake to answer.
process.env.DESKTOP_AGENT_JOB = job.id
process.env.DESKTOP_AGENT_JOB_CAPS = job.capabilities.join(",")

const out = await handOff(`${job.text}\n\n(This is a scheduled job. Nobody is watching it run.)`, {
  workspace: Number(process.env.DESKTOP_AGENT_WORKSPACE) || 10,
})

remember(`[scheduled] ${job.text}`, out.ok ? out.summary : `failed: ${out.summary}`, "agent")

// The report matters more here than for an interactive run, not less: nobody
// watched this happen, so the written account is the only account. It was
// being skipped because report-writing lived in the voice daemon, which a
// timer does not go through.
if (out.report.trim()) {
  try {
    const dir = `${HOME}/.local/state/desktop-agent/runs`
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const body = `> [scheduled ${job.recurrent ? "repeating" : "one-off"}] ${job.text}\n\n${out.report.trim()}\n`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/${stamp}.md`, body)
    writeFileSync(`${HOME}/.local/state/desktop-agent/last-run.md`, body)
  } catch {}
}

// Told about, either way. A scheduled task that succeeds silently is one you
// stop trusting, and one that fails silently is worse.
notify(
  out.ok ? "Scheduled task done" : "Scheduled task failed",
  `${job.text}\n\n${out.summary}`,
  out.ok ? "normal" : "critical",
)

if (!job.recurrent) { try { unlinkSync(`${JOBS}/${jobId}.json`) } catch {} }
process.exit(out.ok ? 0 : 1)
