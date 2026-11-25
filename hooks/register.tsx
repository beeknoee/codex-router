import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limits, Row, Stats, Win } from '../types'
import { DESCRIPTION, INPUT_SCHEMA, TOOL, delegateArgv } from './delegate'
import type { DelegateInput } from './delegate'

const CHUNK = 4 * 1024 * 1024

const EMPTY: Stats = { claude: [], codex: [], at: 0 }
// Change a tag when that value's shape changes: it declines what an earlier version stored.
const stats = atom({ plugin: 'codex-router', key: 'stats' } as const, EMPTY, {
  shape: 'stats-2',
})

// Whether the card above the prompt is open (a press on the chip toggles it).
const pinned = atom({ plugin: 'codex-router', key: 'pinned' } as const, false, {
  shape: 'pinned-1',
})

// Whether Codex may edit files in this session. The switch in the card flips it; the truth
// is the file `write-mode/<session>.txt` next to the ledger, which bin/codex-delegate.mjs
// reads. Claude cannot flip it: the tool has no such argument.
const writeMode = atom({ plugin: 'codex-router', key: 'write' } as const, false, {
  shape: 'write-1',
})

// The Codex CLI's state, from bin/codex-status.mjs: ok, login (not signed in), missing, unknown.
const codexState = atom({ plugin: 'codex-router', key: 'codex' } as const, 'unknown', {
  shape: 'codex-1',
})

// Whether the user switched Codex off for every session. The switch in the card flips it; the
// truth is the file `codex-off.txt` ("disabled" or "enabled") next to the ledger, which the
// delegate script reads too, so a call then sends nothing to Codex.
const codexOff = atom({ plugin: 'codex-router', key: 'off' } as const, 'enabled', {
  shape: 'off-2',
})

// Whether the reserve guard is on (the card's "Tự tắt" switch); truth is codex-guard.txt.
const guardOn = atom({ plugin: 'codex-router', key: 'guard' } as const, true, {
  shape: 'guard-1',
})

// Whether the user asked Claude to prefer Codex (the card's "Ưu tiên Codex" switch).
const priorityOn = atom({ plugin: 'codex-router', key: 'priority' } as const, false, {
  shape: 'prio-1',
})

// How much of Codex's usage limits is left (5 hours and a week), from bin/codex-limits.mjs.
const NO_LIMITS: Limits = { at: 0, plan: '' }
const limits = atom({ plugin: 'codex-router', key: 'limits' } as const, NO_LIMITS, {
  shape: 'limits-1',
})
let limitsNow: Limits = NO_LIMITS

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// Module variables start over on a reload: the transcript is then read again from 0.
const msgs = new Map<string, { model: string; u: Usage }>()
type Cursor = { offset: number; carry: string }
// Read position in this session's transcript.
const main: Cursor = { offset: 0, carry: '' }
// Earlier sessions this conversation came from (a compact or a resume starts a new session
// with a new transcript). Their transcripts are read too, so the Claude side covers the
// whole chain like the Codex side does. path '' = no transcript found for that id.
const chain = new Map<string, Cursor & { path: string }>()
const MAX_CHAIN = 12
let transcript = ''
let sessionId = ''
let ledger = ''
let last = ''
let busy = false
let dirty = false // figures changed since the last history write
let lastSave = 0
let startedAt = 0
let latest: Stats = { claude: [], codex: [], at: 0 }
// Codex rows of the last good read of the ledger, shown again if a read fails.
let lastCodex: Row[] = []
// Ids of earlier sessions this conversation came from (seen in the transcript), so a
// resume, a move to a folder or a /clear does not drop their Codex calls.
const linked = new Set<string>()
const LINK = /(?:-Session\s+|session=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g

const num = (n: number | undefined) => (typeof n === 'number' ? n : 0)

const short = (model: string) => model.replace(/^claude-/, '')

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const sum = (rows: Row[], k: 'fresh' | 'cached' | 'out' | 'calls') =>
  rows.reduce((n, r) => n + r[k], 0)

// Codex calls are written by the delegate script, one JSON line per call.
async function ledgerPath($: any): Promise<string> {
  if (!ledger) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    ledger = `${home}/.claude/codex-router/ledger.jsonl`.replace(/\\/g, '/')
  }
  return ledger
}

const dirOf = (p: string) => p.replace(/\\/g, '/').replace(/\/[^/]*$/, '')

// Reads what a transcript gained since the cursor. An assistant message is written once
// per content block with the same id: the last one holds its totals, and the same id in
// two transcripts (a compact copies earlier messages) is one message.
async function readFileInto($: any, path: string, cur: Cursor) {
  const { size } = await $.fs.stat(path)
  if (size < cur.offset) throw new Error('shrunk')
  while (cur.offset < size) {
    const length = Math.min(size - cur.offset, CHUNK)
    const text: string = await $.fs.read(path, { offset: cur.offset, length })
    cur.offset += length
    const lines = (cur.carry + text).split('\n')
    cur.carry = lines.pop() ?? ''
    for (const line of lines) {
      if (line.includes('-Session') || line.includes('session=')) {
        for (const m of line.matchAll(LINK)) if (m[1]) linked.add(m[1])
      }
      if (!line.includes('"usage"')) continue
      try {
        const o = JSON.parse(line)
        const m = o?.message
        if (o?.type === 'assistant' && m?.id && m.usage) {
          msgs.set(m.id, { model: m.model ?? 'unknown', u: m.usage })
        }
      } catch {
        // a line cut mid-way by a chunk edge: ignore
      }
    }
  }
}

// Where the transcript of an earlier session is: the same project folder, else a sibling one
// (a session moved to another folder keeps its id but its file stays in the old folder).
async function findTranscript($: any, id: string): Promise<string> {
  const dir = dirOf(transcript)
  const same = `${dir}/${id}.jsonl`
  try {
    if (await $.fs.exists(same)) return same
    const parent = dirOf(dir)
    for (const e of await $.fs.list(parent)) {
      if (e.kind !== 'dir') continue
      const p = `${parent}/${e.name}/${id}.jsonl`
      if (await $.fs.exists(p)) return p
    }
  } catch {
    // not found
  }

  return ''
}

async function readClaude($: any) {
  if (!transcript) transcript = (await $.session.info()).transcriptPath
  if (!transcript) return
  try {
    await readFileInto($, transcript, main)
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'shrunk') throw e
    // the file was cut or replaced: read everything again
    main.offset = 0
    main.carry = ''
    msgs.clear()
    linked.clear()
    chain.clear()
    await readFileInto($, transcript, main)
  }
  // Earlier sessions named in the transcript; each can name its own, so go on until none is new.
  for (let round = 0; round < MAX_CHAIN; round++) {
    let added = false
    for (const id of [...linked]) {
      if (id === sessionId || chain.has(id) || chain.size >= MAX_CHAIN) continue
      chain.set(id, { offset: 0, carry: '', path: await findTranscript($, id) })
      added = true
    }
    for (const c of chain.values()) {
      if (!c.path) continue
      try {
        await readFileInto($, c.path, c)
      } catch {
        c.offset = 0
        c.carry = ''
      }
    }
    if (!added) break
  }
}

// How many earlier sessions of the chain were found and read.
const chainFound = () => [...chain.values()].filter(c => c.path).length

function claudeRows(): Row[] {
  const by = new Map<string, Row>()
  for (const { model, u } of msgs.values()) {
    if (model === '<synthetic>') continue
    const r = by.get(model) ?? { label: short(model), calls: 0, fresh: 0, cached: 0, out: 0 }
    r.calls += 1
    r.fresh += num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens)
    r.cached += num(u.cache_read_input_tokens)
    r.out += num(u.output_tokens)
    by.set(model, r)
  }
  return [...by.values()].sort((a, b) => b.fresh - a.fresh)
}

async function codexRows($: any): Promise<Row[]> {
  let text = ''
  try {
    const path = await ledgerPath($)
    const { size } = await $.fs.stat(path)
    const from = Math.max(0, size - CHUNK)
    text = await $.fs.read(path, { offset: from, length: size - from })
  } catch {
    return lastCodex // a failed read (file busy while it is written) must not show 0
  }
  const by = new Map<string, Row>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const o = JSON.parse(line)
      if (o.session !== sessionId && !linked.has(o.session)) continue
      // A call that failed before using any token is not a call; one that failed after is.
      if (o.ok === false && !num(o.input) && !num(o.output)) continue
      const key = `${o.model}`
      const r = by.get(key) ?? { label: key, calls: 0, fresh: 0, cached: 0, out: 0 }
      r.calls += 1
      r.fresh += Math.max(0, num(o.input) - num(o.cached)) + num(o.output)
      r.cached += num(o.cached)
      r.out += num(o.output)
      by.set(key, r)
    } catch {
      // ignore a damaged line
    }
  }
  lastCodex = [...by.values()].sort((a, b) => b.fresh - a.fresh)
  return lastCodex
}

// The share of new tokens; pc is null until there is any.
function share(s: Stats): { pc: number | null; c: number; x: number } {
  const c = sum(s.claude, 'fresh')
  const x = sum(s.codex, 'fresh')
  const t = c + x

  return { pc: t === 0 ? null : Math.round((c * 100) / t), c, x }
}

// The same share when cache reads count too (they are most of what Claude's sessions read).
function shareAll(s: Stats): { pc: number | null; c: number; x: number } {
  const c = sum(s.claude, 'fresh') + sum(s.claude, 'cached')
  const x = sum(s.codex, 'fresh') + sum(s.codex, 'cached')
  const t = c + x

  return { pc: t === 0 ? null : Math.round((c * 100) / t), c, x }
}

async function tick($: any) {
  if (busy) return
  busy = true
  try {
    // A /clear keeps this module loaded but starts a new session and transcript.
    const id: string = await $.session.id()
    const path: string = (await $.session.info()).transcriptPath
    if (id !== sessionId || path !== transcript) {
      sessionId = id
      transcript = path
      main.offset = 0
      main.carry = ''
      msgs.clear()
      linked.clear()
      chain.clear()
      lastCodex = []
      startedAt = 0
      lastSave = 0
      last = ''
    }
    try {
      await readClaude($)
    } catch {
      // transcript not readable yet: show what we have
    }
    const next: Stats = { claude: claudeRows(), codex: await codexRows($), at: 0, chain: chainFound() }
    latest = next
    const key = JSON.stringify(next)
    if (key === last) return
    last = key
    dirty = true
    await update($, stats, () => ({ ...next, at: Date.now() }))
  } finally {
    busy = false
    void saveHistory($)
  }
}

// Asks the status script whether Codex is installed and signed in; a failure to ask
// (no `node`, the call refused) leaves the last answer as it was.
async function checkCodex($: any) {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/codex-status.mjs`], {
      timeoutMs: 20000,
    })
    const word = r.stdout.trim()
    const state = word === 'ok' || word === 'login' || word === 'missing' ? word : 'unknown'
    await update($, codexState, () => state)
  } catch {
    // keep the last state
  }
}

// HISTORY:BEGIN
type Snap = {
  session: string
  cwd?: string
  startedAt?: number
  updatedAt: number
  from?: string[]
  claude: Row[]
  codex: Row[]
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
const two = (n: number) => String(n).padStart(2, '0')
const dayOf = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
const split = (c: number, x: number) =>
  c + x === 0 ? '–' : `${Math.round((c * 100) / (c + x))}% / ${100 - Math.round((c * 100) / (c + x))}%`

// One file per session, rewritten with the latest figures (a session's file name is its id).
async function historyDir($: any): Promise<string> {
  return (await ledgerPath($)).replace(/ledger\.jsonl$/, 'history')
}

// The flag file of this session's write mode ("on" or "off"); absent means off.
async function writeFlagPath($: any): Promise<string> {
  const id: string = sessionId || (await $.session.id())
  return `${(await ledgerPath($)).replace(/ledger\.jsonl$/, 'write-mode')}/${id}.txt`
}

async function flagIsOn($: any): Promise<boolean> {
  try {
    return String(await $.fs.read(await writeFlagPath($))).trim() === 'on'
  } catch {
    return false
  }
}

// Flips the switch: writes the flag file first, then the value the card draws.
async function toggleWrite($: any) {
  const next = !(await flagIsOn($))
  try {
    await $.fs.write(await writeFlagPath($), next ? 'on' : 'off')
  } catch {
    $.ui.toast('Không ghi được công tắc sửa file của Codex.')
    return
  }
  await update($, writeMode, () => next)
  $.ui.toast(next ? 'Codex được sửa file trong phiên này.' : 'Codex chỉ đọc.')
}

// Writes this session's snapshot at most every 10 s, and only after the figures changed.
async function saveHistory($: any) {
  if (!dirty || !sessionId) return
  if (latest.claude.length === 0 && latest.codex.length === 0) return
  const now: number = await $.clock.now()
  if (now - lastSave < 10000) return
  lastSave = now
  dirty = false
  try {
    if (!startedAt) startedAt = (await $.session.usage()).startedAt
    const snap: Snap = {
      session: sessionId,
      cwd: await $.session.cwd(),
      startedAt,
      updatedAt: now,
      from: [...linked].filter(id => id !== sessionId),
      claude: latest.claude,
      codex: latest.codex,
    }
    await $.fs.write(`${await historyDir($)}/${sessionId}.json`, JSON.stringify(snap))
  } catch {
    dirty = true // try again at the next tick
  }
}

// The history the command prints: by day, then the latest sessions.
async function historyText($: any): Promise<string> {
  const dir = await historyDir($)
  let entries: any
  try {
    entries = await $.fs.list(dir)
  } catch {
    return 'Chưa có lịch sử. Lịch sử được lưu sau lượt trả lời đầu tiên của mỗi phiên.'
  }
  const names: string[] = (Array.isArray(entries) ? entries : (entries?.entries ?? []))
    .map((e: any) => e.name)
    .filter((n: string) => n.endsWith('.json'))
  const snaps: Snap[] = []
  for (const n of names) {
    try {
      snaps.push(JSON.parse(await $.fs.read(`${dir}/${n}`)))
    } catch {
      // a damaged or half-written file: skip
    }
  }
  // A session that was resumed or moved holds its earlier session's figures: count it once.
  const covered = new Set(snaps.flatMap(s => s.from ?? []))
  const live = snaps.filter(s => !covered.has(s.session))
  if (live.length === 0) return 'Chưa có lịch sử.'
  const tot = (s: Snap) => ({ c: sum(s.claude, 'fresh'), x: sum(s.codex, 'fresh') })

  const days = new Map<string, { c: number; x: number; n: number }>()
  for (const s of live) {
    const k = dayOf(s.updatedAt)
    const d = days.get(k) ?? { c: 0, x: 0, n: 0 }
    const t = tot(s)
    d.c += t.c
    d.x += t.x
    d.n += 1
    days.set(k, d)
  }
  const dayLines = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14)
    .map(([k, d]) => `  ${pad(k, 12)}${padL(fmt(d.c), 9)}${padL(fmt(d.x), 9)}   ${pad(split(d.c, d.x), 11)}${padL(`${d.n}`, 4)}`)

  const sessLines = [...live]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10)
    .map(s => {
      const t = tot(s)
      const d = new Date(s.updatedAt)
      const dir2 = (s.cwd ?? '').replace(/[\/]+$/, '').split(/[\/]/).pop() || '(không rõ)'

      return `  ${dayOf(s.updatedAt)} ${two(d.getHours())}:${two(d.getMinutes())}  ${pad(dir2.slice(0, 22), 23)}${padL(fmt(t.c), 9)}${padL(fmt(t.x), 9)}   ${split(t.c, t.x)}`
    })

  const all = live.reduce((a, s) => ({ c: a.c + tot(s).c, x: a.x + tot(s).x }), { c: 0, x: 0 })

  return [
    'Lịch sử Claude và Codex (token mới)',
    '',
    `Theo ngày (14 ngày gần nhất)`,
    `  ${pad('Ngày', 12)}${padL('Claude', 9)}${padL('Codex', 9)}   ${pad('Tỷ lệ', 11)}${padL('Phiên', 4)}`,
    ...dayLines,
    '',
    '10 phiên gần nhất',
    `  ${pad('Cập nhật', 17)}${pad('Thư mục', 23)}${padL('Claude', 9)}${padL('Codex', 9)}   Tỷ lệ`,
    ...sessLines,
    '',
    `Tổng ${live.length} phiên: Claude ${fmt(all.c)} · Codex ${fmt(all.x)} · ${split(all.c, all.x)}`,
    'Mỗi phiên một file trong thư mục history cạnh sổ ghi Codex. Phiên được tiếp tục hoặc chuyển thư mục chỉ tính một lần.',
  ].join('\n')
}
// HISTORY:END

// The flag file of the "Codex off" switch; it holds "disabled" or "enabled", absent means on.
async function offFlagPath($: any): Promise<string> {
  return (await ledgerPath($)).replace(/ledger\.jsonl$/, 'codex-off.txt')
}

type OffState = 'enabled' | 'disabled' | 'auto'

// What the "Codex" switch says, from codex-off.txt: "disabled" (the user turned it off), "auto"
// (the reserve guard turned it off) or "enabled"; absent means enabled.
async function offState($: any): Promise<OffState> {
  try {
    const v = String(await $.fs.read(await offFlagPath($))).trim()

    return v === 'disabled' || v === 'auto' ? v : 'enabled'
  } catch {
    return 'enabled'
  }
}

// True while Codex is off, whoever turned it off.
async function offIsOn($: any): Promise<boolean> {
  return (await offState($)) !== 'enabled'
}

// Writes the flag file first, then the value the card draws.
async function setOff($: any, v: OffState): Promise<boolean> {
  try {
    await $.fs.write(await offFlagPath($), v)
  } catch {
    return false
  }
  await update($, codexOff, () => v)

  return true
}

// The flag file of the guard switch: "on" or "off"; absent means on.
async function guardFlagPath($: any): Promise<string> {
  return (await ledgerPath($)).replace(/ledger\.jsonl$/, 'codex-guard.txt')
}

async function guardIsOn($: any): Promise<boolean> {
  try {
    return String(await $.fs.read(await guardFlagPath($))).trim() !== 'off'
  } catch {
    return true
  }
}

// Keeps the Codex switch in line with the guard. Guard on and the 5 hour window at or below
// the reserve: the switch turns itself off ("auto"). Window reset, or guard switched off: a
// switch the guard turned off turns itself on again. A switch the user turned off is left alone.
async function applyGuard($: any) {
  const st = await offState($)
  const low = (await guardIsOn($)) && pausedLeft(limitsNow) !== null
  if (low && st === 'enabled') await setOff($, 'auto')
  else if (!low && st === 'auto') await setOff($, 'enabled')
}

// The "Codex" switch. Turning it on while the guard holds it off is refused: the guard switch is the override.
async function toggleOff($: any) {
  const st = await offState($)
  if (st === 'enabled') {
    $.ui.toast((await setOff($, 'disabled')) ? 'Đã tắt giao việc cho Codex (mọi phiên).' : 'Không ghi được công tắc tắt Codex.')

    return
  }
  if ((await guardIsOn($)) && pausedLeft(limitsNow) !== null) {
    $.ui.toast(`Hạn mức 5 giờ còn <= ${reserve}%. Tắt công tắc "Tự tắt" nếu vẫn muốn dùng Codex.`)

    return
  }
  $.ui.toast((await setOff($, 'enabled')) ? 'Đã bật lại giao việc cho Codex.' : 'Không ghi được công tắc tắt Codex.')
}

// The guard switch: whether the reserve turns Codex off by itself.
async function toggleGuard($: any) {
  const next = !(await guardIsOn($))
  try {
    await $.fs.write(await guardFlagPath($), next ? 'on' : 'off')
  } catch {
    $.ui.toast('Không ghi được công tắc tự tắt Codex.')

    return
  }
  await update($, guardOn, () => next)
  await applyGuard($)
  $.ui.toast(
    next
      ? `Bật tự tắt Codex khi hạn mức 5 giờ còn <= ${reserve}%.`
      : 'Đã tắt chế độ tự tắt: Codex không tự dừng khi hạn mức thấp.',
  )
}

// The "Ưu tiên Codex" switch: while it is on, every prompt carries a short note (a hidden context
// block, the user's own text is not touched) that tells Claude to hand Codex more work, including
// the hard jobs. The truth is the file codex-priority.txt ("on" or "off"), shared by every session.
const PRIORITY_NOTE =
  'Codex priority is ON (the user switched it on in the chip card). Prefer Codex: hand it every read, search, analysis or drafting job that is clearly separable, from about 1k tokens of work, and give it the hard jobs too (hard bugs, architecture analysis, algorithm drafts, large diff reviews) with the hard tier instead of doing them yourself. You still decide, do the edits (unless write mode is on) and check the lines it cites. If it replies that Codex is switched off or paused, do the job yourself.'

async function priorityFlagPath($: any): Promise<string> {
  return (await ledgerPath($)).replace(/ledger\.jsonl$/, 'codex-priority.txt')
}

async function priorityIsOn($: any): Promise<boolean> {
  try {
    return String(await $.fs.read(await priorityFlagPath($))).trim() === 'on'
  } catch {
    return false
  }
}

async function togglePriority($: any) {
  const next = !(await priorityIsOn($))
  try {
    await $.fs.write(await priorityFlagPath($), next ? 'on' : 'off')
  } catch {
    $.ui.toast('Không ghi được công tắc ưu tiên Codex.')

    return
  }
  await update($, priorityOn, () => next)
  $.ui.toast(next ? 'Ưu tiên Codex: Claude sẽ giao nhiều việc hơn, kể cả việc khó.' : 'Đã tắt ưu tiên Codex.')
}

// Asks the limits script how much of Codex's 5 hour and weekly limits is used. It reads the
// figures Codex wrote in its own session files, so it is as fresh as the last Codex turn on
// this machine. A failure to ask keeps the last figures.
async function checkLimits($: any) {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/bin/codex-limits.mjs`], {
      timeoutMs: 20000,
    })
    const o = JSON.parse(r.stdout.trim() || '{}')
    limitsNow = o && o.at ? { at: o.at, plan: o.plan ?? '', p: o.p, s: o.s } : NO_LIMITS
    await update($, limits, () => limitsNow)
    await applyGuard($)
  } catch {
    // keep the last figures
  }
}

const winName = (m: number) =>
  m === 300 ? '5 giờ' : m === 10080 ? 'Tuần' : m % 60 === 0 ? `${m / 60} giờ` : `${m} phút`

// Percent left. A window whose reset time has passed has started again, so it is full.
const leftPct = (w: Win, now: number) =>
  w.resetsAt && w.resetsAt <= now ? 100 : Math.max(0, Math.min(100, Math.round(100 - w.used)))

const inText = (ms: number, now: number) => {
  const m = Math.max(0, Math.round((ms - now) / 60000))
  if (m >= 1440) return `${Math.floor(m / 1440)} ngày ${Math.floor((m % 1440) / 60)}g`
  if (m >= 60) return `${Math.floor(m / 60)}g ${m % 60}p`

  return `${m}p`
}

const hhmm = (ms: number) => {
  const d = new Date(ms)

  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

const winsOf = (l: Limits): Win[] => [l.p, l.s].filter((w): w is Win => !!w)

const resetText = (w: Win, now: number) =>
  w.resetsAt && w.resetsAt <= now ? 'đã đặt lại' : `đặt lại sau ${inText(w.resetsAt, now)}`

const limitColor = (left: number) => (left <= 10 ? 'red' : left <= 30 ? 'yellow' : 'green')

// The user keeps this percent of the 5 hour limit for themselves: while that window has this
// much or less left, the delegate script pauses Codex by itself (0 = never). The plugin option
// `reserve_percent` sets it; the script reads the same option from its command line.
let reserve = 20

// Percent left of the 5 hour window when it is at or below the reserve (Codex is paused), else null.
function pausedLeft(l: Limits): number | null {
  const now = Date.now()
  if (reserve <= 0 || !l.p || (l.p.resetsAt && l.p.resetsAt <= now)) return null
  const left = leftPct(l.p, now)

  return left <= reserve ? left : null
}

// The limits block of the card: one bar per window, how much is left and when it starts again.
function limitBlock(Box: any, Text: any, l: Limits) {
  const now = Date.now()
  const rows = winsOf(l)
  const width = 20
  const row = (w: Win) => {
    const left = leftPct(w, now)
    const filled = Math.round((width * left) / 100)

    return (
      <Box key={`limit-${w.minutes}`} flexDirection="row">
        <Box width={8}>
          <Text>{winName(w.minutes)}</Text>
        </Box>
        <Text color={limitColor(left)}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(width - filled)}</Text>
        <Text>{` còn ${left}%`}</Text>
        <Text dimColor>{`  ${resetText(w, now)}`}</Text>
      </Box>
    )
  }

  return (
    <Box key="codex-limits" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text dimColor>
          {rows.length === 0
            ? 'Hạn mức Codex: chưa có số liệu (chạy Codex một lần là có).'
            : `Hạn mức Codex còn lại${l.plan ? ` · gói ${l.plan}` : ''}`}
        </Text>
        {rows.length > 0 && <Text dimColor>|</Text>}
        {rows.length > 0 && (
          <Text dimColor>{`Số liệu lúc ${hhmm(l.at)}, theo lần chạy Codex gần nhất trên máy này.`}</Text>
        )}
      </Box>
      {rows.map(row)}
    </Box>
  )
}

// The same figures as plain lines for `/codex-router`.
function limitsText(l: Limits, st: OffState): string[] {
  const now = Date.now()
  const rows = winsOf(l)

  return [
    '',
    ...(st === 'disabled' ? ['Giao việc cho Codex: ĐANG TẮT (mọi phiên). Bật lại bằng công tắc trong thẻ.'] : []),
    ...(st === 'auto'
      ? [`Codex đã tự tắt: hạn mức 5 giờ còn <= ${reserve}%. Tự bật lại khi hạn mức đặt lại. Muốn dùng ngay thì tắt công tắc "Tự tắt" trong thẻ.`]
      : []),
    ...(rows.length === 0
      ? ['Hạn mức Codex: chưa có số liệu (chạy Codex một lần là có).']
      : [
          `Hạn mức Codex còn lại${l.plan ? ` · gói ${l.plan}` : ''}`,
          ...rows.map(w => `  ${winName(w.minutes)}: còn ${leftPct(w, now)}% · ${resetText(w, now)}`),
          `  (số liệu lúc ${hhmm(l.at)}, theo lần chạy Codex gần nhất trên máy này)`,
        ]),
  ]
}

// One line with the share when cache reads count as well.
function allLine(s: Stats): string {
  const a = shareAll(s)
  if (a.pc === null) return ''

  return `Đã gồm token đọc cache: Claude ${fmt(a.c)} (${a.pc}%) · Codex ${fmt(a.x)} (${100 - a.pc}%)`
}

// The breakdown that `/codex-router` prints into the chat.
function detailText(s: Stats, lim: Limits, st: OffState): string {
  const { pc, c, x } = share(s)
  const head = pc === null ? 'Claude – · Codex –' : `Claude ${pc}% · Codex ${100 - pc}%`
  const rows = (rs: Row[], unit: string) =>
    rs.map(r => `  ${r.label}: ${fmt(r.fresh)} mới · ${fmt(r.cached)} cache · ${r.calls} ${unit}`)

  return [
    `Claude vs Codex (phiên này): ${head}`,
    '',
    `Claude · ${fmt(c)} mới · ${sum(s.claude, 'calls')} lượt`,
    ...rows(s.claude, 'lượt'),
    '',
    `Codex · ${fmt(x)} mới · ${sum(s.codex, 'calls')} lần gọi`,
    ...(s.codex.length === 0 ? ['  chưa giao việc cho Codex'] : rows(s.codex, 'lần')),
    '',
    'Tỷ lệ theo token mới (input chưa cache + ghi cache + output). Chưa tính subagent của Claude.',
    allLine(s),
    ...limitsText(lim, st),
    ...(s.chain ? [`Gồm ${s.chain} phiên trước nối tiếp (sau compact hoặc tiếp tục).`] : []),
  ].join('\n')
}

// Column widths in cells. The three number columns are right-aligned so digits line up.
const COLS = { name: 20, fresh: 12, cache: 12, calls: 8 }

type Kind = 'head' | 'claude' | 'codex' | 'item'

// One row of the table, drawn in the same four columns for headers, totals and models.
function tableRow(
  Box: any,
  Text: any,
  kind: Kind,
  name: string,
  fresh: string,
  cache: string,
  calls: string,
) {
  const style =
    kind === 'head'
      ? { dimColor: true }
      : kind === 'claude'
        ? { bold: true, color: 'cyan' }
        : kind === 'codex'
          ? { bold: true, color: 'green' }
          : {}

  return (
    <Box flexDirection="row">
      <Box width={COLS.name}>
        <Text {...style}>{name}</Text>
      </Box>
      <Box width={COLS.fresh} justifyContent="flex-end">
        <Text {...style}>{fresh}</Text>
      </Box>
      <Box width={COLS.cache} justifyContent="flex-end">
        <Text {...style}>{cache}</Text>
      </Box>
      <Box width={COLS.calls} justifyContent="flex-end">
        <Text {...style}>{calls}</Text>
      </Box>
    </Box>
  )
}

// The card above the prompt: the share on top, a bar, then one table for both sides.
function card(
  Box: any,
  Text: any,
  Button: any,
  s: Stats,
  canWrite: boolean,
  onToggle: () => unknown,
  lim: Limits,
  off: boolean,
  auto: boolean,
  onOff: () => unknown,
  guard: boolean,
  onGuard: () => unknown,
  priority: boolean,
  onPriority: () => unknown,
  shift: number,
  onClose: () => unknown,
) {
  const { pc } = share(s)
  const width = 30
  const filled = Math.round((width * (pc ?? 0)) / 100)
  const item = (r: Row) => tableRow(Box, Text, 'item', `  ${r.label}`, fmt(r.fresh), fmt(r.cached), `${r.calls}`)

  return (
    <Box key="token-ratio-card" flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={2} marginLeft={shift}>
            <Button plain label={off ? 'Codex tắt  ○━' : 'Codex bật  ━●'} onPress={onOff}>
              <Text>{off ? 'Codex tắt  ○━' : 'Codex bật  ━●'}</Text>
            </Button>
            {!off && (
              <Button plain label={priority ? 'Ưu tiên Codex  ━●' : 'Ưu tiên Codex  ○━'} onPress={onPriority}>
                <Text>{priority ? 'Ưu tiên Codex  ━●' : 'Ưu tiên Codex  ○━'}</Text>
              </Button>
            )}
            {reserve > 0 && (
              <Button plain label={guard ? `Tự tắt ≤${reserve}%  ━●` : `Tự tắt ≤${reserve}%  ○━`} onPress={onGuard}>
                <Text>{guard ? `Tự tắt ≤${reserve}%  ━●` : `Tự tắt ≤${reserve}%  ○━`}</Text>
              </Button>
            )}
            {!off && (
              <Button plain label={canWrite ? 'Sửa  ━●' : 'Đọc  ○━'} onPress={onToggle}>
                <Text>{canWrite ? 'Sửa  ━●' : 'Đọc  ○━'}</Text>
              </Button>
            )}
          </Box>
          <Button role="dismiss" onPress={onClose}>
            ✕
          </Button>
        </Box>
        {pc === null ? (
          <Text dimColor>Chưa có số liệu.</Text>
        ) : (
          <Box flexDirection="row" gap={1} marginTop="md">
            <Text color="cyan" bold>{`Claude ${pc}%`}</Text>
            <Text>
              <Text color="cyan">{'█'.repeat(filled)}</Text>
              <Text color="green">{'█'.repeat(width - filled)}</Text>
            </Text>
            <Text color="green" bold>{`Codex ${100 - pc}%`}</Text>
          </Box>
        )}
      </Box>

      <Box flexDirection="row" gap={3}>
      <Box flexDirection="column" flexShrink={0}>
        {tableRow(Box, Text, 'head', 'Model', 'Token mới', 'Cache', 'Số lần')}
        {tableRow(
          Box,
          Text,
          'claude',
          'Claude',
          fmt(sum(s.claude, 'fresh')),
          fmt(sum(s.claude, 'cached')),
          `${sum(s.claude, 'calls')}`,
        )}
        {s.claude.map(item)}
        {tableRow(
          Box,
          Text,
          'codex',
          'Codex',
          fmt(sum(s.codex, 'fresh')),
          fmt(sum(s.codex, 'cached')),
          `${sum(s.codex, 'calls')}`,
        )}
        {s.codex.length === 0 && <Text dimColor>{'  '}chưa giao việc cho Codex</Text>}
        {s.codex.map(item)}
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        {allLine(s) !== '' && <Text dimColor>{`• ${allLine(s)}`}</Text>}
        {!!s.chain && <Text dimColor>{`• Gồm ${s.chain} phiên trước nối tiếp (sau compact hoặc tiếp tục).`}</Text>}
      </Box>
      </Box>

      {limitBlock(Box, Text, lim)}
      {off && auto && (
        <Text color="yellow">Codex tạm dừng vì hạn mức 5 giờ còn {'<='} {reserve}%. Claude tiếp tục làm đến khi hạn mức đặt lại.</Text>
      )}
      {off && !auto && (
        <Text color="yellow">Đã tắt giao việc cho Codex ở mọi phiên: Claude tự làm hết, không gửi gì cho Codex. Bật lại bằng công tắc phía trên.</Text>
      )}
      {canWrite && !off && (
        <Text color="yellow">Codex có thể sửa file trong thư mục dự án. Claude sẽ kiểm tra thay đổi (git diff) sau mỗi lần giao.</Text>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const r = Number(((options ?? {}) as Record<string, string>).reserve_percent)
    if (Number.isFinite(r) && r >= 0 && ((options ?? {}) as Record<string, string>).reserve_percent !== '') reserve = r
    await $.tool.register({
      name: 'codex_delegate',
      description: DESCRIPTION,
      isDeferred: false,
      inputSchema: INPUT_SCHEMA,
    })
    await $.command.register({
      name: 'codex-router',
      description: 'Print the Claude vs Codex token breakdown of this session',
    })
    $.ui.status(undefined) // older versions pinned a text line here, prefixed with the mod's name
    void tick($)
    $.clock.every(3000, () => tick($))
    await $.command.register({
      name: 'codex-history',
      description: 'Print the saved Claude vs Codex history, by day and by session',
    })
    void checkCodex($)
    $.clock.every(60000, () => checkCodex($))
    // The card shows what the flag file says, also after a resume or a reload.
    const syncWrite = () => flagIsOn($).then(isOn => update($, writeMode, () => isOn))
    void syncWrite()
    $.clock.every(5000, syncWrite)
    const syncOff = async () => {
      const st = await offState($)
      await update($, codexOff, () => st)
      const g = await guardIsOn($)
      await update($, guardOn, () => g)
      const pr = await priorityIsOn($)
      await update($, priorityOn, () => pr)
      await applyGuard($)
    }
    void syncOff()
    $.clock.every(5000, syncOff)
    void checkLimits($)
    $.clock.every(30000, () => checkLimits($))

    return next(e)
  })

  on('tool.run', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as DelegateInput
    if (!input.prompt || !input.prompt.trim()) return { deny: 'codex_delegate: prompt is required.' }
    const off = await offState($)
    if (off !== 'enabled') {
      return {
        result:
          off === 'auto'
            ? '[codex is paused: its 5-hour limit is at or below the reserve the user keeps for themselves. Nothing was sent to Codex. Do this task yourself and do not call codex_delegate again until it starts again.]'
            : '[codex is switched off by the user: nothing was sent to Codex. Do this task yourself and do not call codex_delegate again in this conversation unless the user turns Codex back on.]',
      }
    }
    const argv = delegateArgv(
      $.plugin.root,
      await ledgerPath($),
      await $.session.id(),
      input,
      (options ?? {}) as Record<string, string>,
    )
    const r = await $.process.run(argv, { stdin: input.prompt, timeoutMs: 600000 })
    void tick($)
    void checkLimits($)
    const cut = r.isStdoutTruncated ? '\n[output truncated at 4 MiB]' : ''
    const text =
      (r.stdout.trim() || r.stderr.trim() || `codex_delegate failed (exit ${r.exitCode})`) + cut

    return r.exitCode === 0 ? { result: text } : { deny: text }
  })

  on('command.run', { command: 'codex-router' }, async $ => {
    await tick($)

    return { text: detailText(latest, limitsNow, await offState($)) }
  })

  on('command.run', { command: 'codex-history' }, async $ => {
    return { text: await historyText($) }
  })

  // While the priority switch is on and Codex is available, each prompt carries the note as a hidden
  // context block: the user's own words are not changed.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    if (!(await priorityIsOn($)) || (await offIsOn($))) return next(e)

    return next({ ...e, context: [...(e.context ?? []), PRIORITY_NOTE] })
  })

  on('turn.complete', async ($, e, next) => {
    void tick($)
    void checkLimits($)

    return next(e)
  })

  // The chip in the prompt footer, in the row of the model and effort pickers. A press
  // opens or closes the card in the band above the prompt. The desktop draws a Button as
  // a native pill carrying its label, so the label is the text itself. (A toast flattens
  // line breaks and a hover card is clipped by the footer, so neither is used.)
  // `/codex-router` prints the same breakdown into the chat.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, stats)
    const { pc } = share(s)
    const codex = await read($, codexState)
    const label = pc === null ? 'Claude – · Codex –' : `Claude ${pc}% · Codex ${100 - pc}%`

    return (
      <Box key="token-ratio-mode" flexDirection="row" gap={1}>
        <Button plain label={label} onPress={() => update($, pinned, v => !v)}>
          <Text>{label}</Text>
        </Button>
        {codex === 'login' && <Text dimColor>(chưa đăng nhập)</Text>}
        {codex === 'missing' && <Text dimColor>(chưa cài Codex)</Text>}
        {engine}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, pinned))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, stats)
    const canWrite = await read($, writeMode)
    const lim = await read($, limits)
    const st = await read($, codexOff)
    const guard = await read($, guardOn)
    const priority = await read($, priorityOn)
    const off = st !== 'enabled'

    return card(
      Box,
      Text,
      Button,
      s,
      canWrite,
      () => toggleWrite($),
      lim,
      off,
      st === 'auto',
      () => toggleOff($),
      guard,
      () => toggleGuard($),
      priority,
      () => togglePriority($),
      e.surface === 'desktop' ? -1.5 : 0,
      () => update($, pinned, () => false),
    )
  })
}
