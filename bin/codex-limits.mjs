#!/usr/bin/env node
// codex-limits.mjs - prints one JSON line with how much of the Codex usage limits is used:
//   {"at":<ms>,"plan":"team","p":{"used":97,"minutes":300,"resetsAt":<ms>},"s":{"used":49,"minutes":10080,"resetsAt":<ms>}}
// p is the short window (5 hours), s the long one (a week). Prints {} when nothing is known.
//
// Codex records the limits it was told in every token_count event of its session files
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, or $CODEX_HOME). This reads the newest of
// those files and takes the latest figure, so it is as fresh as the last Codex turn anywhere
// on this machine (the Codex app, the CLI, or codex_delegate). It sends nothing to a model.
// Needs Node 18+.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
const TAIL = 768 * 1024 // a token_count line is about 1 KB and Codex writes one per turn
const DAYS = 4 // newest day folders to look in
const FILES = 8 // newest files to read

const names = (dir, wantDir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => (wantDir ? e.isDirectory() : e.isFile() && e.name.endsWith('.jsonl')))
      .map(e => e.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

// Newest day folders first: year/month/day names sort the same as dates.
const days = []
outer: for (const y of names(root, true)) {
  for (const m of names(join(root, y), true)) {
    for (const d of names(join(root, y, m), true)) {
      days.push(join(root, y, m, d))
      if (days.length >= DAYS) break outer
    }
  }
}

const files = []
for (const day of days) {
  for (const f of names(day, false)) {
    const p = join(day, f)
    try {
      files.push({ p, t: statSync(p).mtimeMs })
    } catch {
      // gone while we looked
    }
  }
}
files.sort((a, b) => b.t - a.t)

// The last limits line of a file, read from its end.
function lastLimits(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const from = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - from)
    readSync(fd, buf, 0, buf.length, from)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"rate_limits"') || !line.includes('"used_percent"')) continue
      try {
        const o = JSON.parse(line)
        const rl = o?.payload?.rate_limits
        if (!rl || (rl.limit_id && rl.limit_id !== 'codex')) continue
        return { at: Date.parse(o.timestamp) || 0, rl }
      } catch {
        // a line cut at the edge of the tail: go on to an earlier one
      }
    }
  } catch {
    // unreadable file: skip it
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  return null
}

const win = w =>
  w && typeof w.used_percent === 'number'
    ? {
        used: Math.round(w.used_percent * 10) / 10,
        minutes: Number(w.window_minutes) || 0,
        resetsAt: (Number(w.resets_at) || 0) * 1000,
      }
    : undefined

let best = null
for (const f of files.slice(0, FILES)) {
  const r = lastLimits(f.p)
  if (r && (!best || r.at > best.at)) best = r
}

if (!best) {
  console.log('{}')
} else {
  console.log(
    JSON.stringify({
      at: best.at,
      plan: best.rl.plan_type || '',
      p: win(best.rl.primary),
      s: win(best.rl.secondary),
    }),
  )
}
