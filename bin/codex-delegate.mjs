#!/usr/bin/env node
// codex-delegate.mjs - run one task on the Codex CLI and record its token use.
//
//   echo "<prompt>" | node codex-delegate.mjs --tier easy|medium|hard
//        [--model M] [--effort E] [--cd DIR]   (read-only, unless the user's write switch is on)
//        [--session ID] [--task LABEL] [--ledger FILE]
//        [--reserve PERCENT]   pause while the 5 hour limit has this much or less left (default 20, 0 = never)
//
// The prompt is read from stdin. stdout: Codex's final answer, then one footer line
// with the token counts. Each call appends one JSON line to the ledger.
// Needs Node 18+ and the `codex` command on PATH (npm i -g @openai/codex, signed in).
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TIERS = {
  easy: { model: 'gpt-6-luna', effort: 'low' },
  medium: { model: 'gpt-6.2-astra', effort: 'medium' },
  hard: { model: 'gpt-6.2-sol', effort: 'high' },
}

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1] ?? ''
}
const tier = TIERS[args.tier] ? args.tier : 'medium'
const model = args.model || TIERS[tier].model
const effort = args.effort || TIERS[tier].effort
const cd = args.cd || process.cwd()
const session = args.session || 'unknown'
const ledger = args.ledger || join(homedir(), '.claude', 'codex-router', 'ledger.jsonl')

// Read-only unless the USER switched write mode on for this session in the chip's card,
// which writes "on" to write-mode/<session>.txt next to the ledger. There is no argument
// for it, so the model that calls this script cannot turn it on.
let writeOn = false
if (/^[\w-]+$/.test(session)) {
  try { writeOn = readFileSync(join(dirname(ledger), 'write-mode', `${session}.txt`), 'utf8').trim() === 'on' } catch {}
}
const sandbox = writeOn ? 'workspace-write' : 'read-only'
const mode = writeOn ? 'write' : 'read-only'
const GUARD = writeOn
  ? 'You may edit files inside the working folder, and only there. Keep changes small and focused on the task. ' +
    'Do not delete files, do not touch files unrelated to the task, do not run git commit, git push or git reset, and do not install packages. ' +
    'End your reply with the list of files you changed and one line on each change.\n\n'
  : 'You are running read-only. Do not create, edit, move or delete any file and do not run commands that change anything. ' +
    'If a change is needed, show it in your reply as a patch or code block for someone else to apply.\n\n'

let prompt = ''
process.stdin.setEncoding('utf8') // decode across chunk edges, not per buffer
for await (const chunk of process.stdin) prompt += chunk
if (!prompt.trim()) {
  console.error('codex-delegate: empty prompt on stdin')
  process.exit(2)
}

// The user can switch Codex off for every session (the card's first switch writes "disabled"
// to codex-off.txt next to the ledger). Then nothing is sent and the caller is told to go on alone.
let disabled = false
try { disabled = readFileSync(join(dirname(ledger), 'codex-off.txt'), 'utf8').trim() === 'disabled' } catch {}
if (disabled) {
  console.log('[codex is switched off by the user: nothing was sent to Codex. Do this task yourself and do not call codex_delegate again in this conversation unless the user turns Codex back on.]')
  process.exit(0)
}

// Keep a reserve of the 5 hour limit for the user's own use: when that window has this many
// percent or less left, pause instead of calling Codex. It starts again by itself once the
// window resets. --reserve 0 turns the guard off; no figures (never ran Codex) means go on.
const reserve = args.reserve !== undefined && args.reserve !== '' && Number.isFinite(Number(args.reserve)) ? Number(args.reserve) : 20
// The card's "Tự tắt" switch writes "off" to codex-guard.txt: then there is no pause at all.
let guardOff = false
try { guardOff = readFileSync(join(dirname(ledger), 'codex-guard.txt'), 'utf8').trim() === 'off' } catch {}
if (reserve > 0 && !guardOff) {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const lim = JSON.parse(execFileSync(process.execPath, [join(here, 'codex-limits.mjs')], { encoding: 'utf8', timeout: 15000 }))
    const w = lim.p
    if (w && w.resetsAt > Date.now() && 100 - w.used <= reserve) {
      const m = Math.max(1, Math.round((w.resetsAt - Date.now()) / 60000))
      console.log(`[codex is paused: its 5-hour limit has ${Math.max(0, Math.round(100 - w.used))}% left, at or below the ${reserve}% the user keeps for themselves. Nothing was sent to Codex. It starts again in about ${Math.floor(m / 60)}h ${m % 60}m. Do this task yourself and do not call codex_delegate again until then.]`)
      process.exit(0)
    }
  } catch {
    // limits unknown: do not block
  }
}

const isWin = process.platform === 'win32'
// On Windows `codex` is a .cmd shim, which needs a shell (cmd.exe). Inside a shell a
// quote does not stop %VAR% expansion or &|<>^ after an embedded quote, so refuse
// those characters in the values that reach the command line; spaces are quoted.
if (isWin) {
  for (const v of [model, effort, cd, sandbox]) {
    if (/["%&|<>^`]/.test(v)) {
      console.error(`codex-delegate: refusing an argument with shell metacharacters on Windows: ${v}`)
      process.exit(2)
    }
  }
}
const q = a => (isWin && /\s/.test(a) ? `"${a}"` : a)
const argv = [
  'exec', '-m', model, '-c', `model_reasoning_effort=${effort}`,
  '-s', sandbox, '-C', cd, '--skip-git-repo-check', '--json', '-',
].map(q)

const started = Date.now()
const child = spawn('codex', argv, { shell: isWin, stdio: ['pipe', 'pipe', 'pipe'] })
let out = ''
let err = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdin.on('error', () => {}) // the child may exit before it reads the prompt (EPIPE)
child.stdout.on('data', d => (out += d))
child.stderr.on('data', d => (err += d))
child.on('error', e => {
  console.error(`codex-delegate: cannot start codex (${e.message}). Install it and sign in first.`)
  process.exit(127)
})
child.stdin.end(GUARD + prompt)

child.on('close', code => {
  let input = 0, cached = 0, output = 0, reasoning = 0, reply = '', errMsg = '', failed = code !== 0
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'turn.completed' && ev.usage) {
      input += ev.usage.input_tokens ?? 0
      cached += ev.usage.cached_input_tokens ?? 0
      output += ev.usage.output_tokens ?? 0
      reasoning += ev.usage.reasoning_output_tokens ?? 0
    } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
      reply = ev.item.text
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      failed = true
      errMsg = ev.error?.message || ev.message || errMsg
    }
  }
  const ms = Date.now() - started
  try {
    mkdirSync(dirname(ledger), { recursive: true })
    appendFileSync(ledger, JSON.stringify({
      ts: new Date().toISOString(), session, tier, model, effort, task: args.task || '',
      input, cached, output, reasoning, ms, ok: !failed, mode,
    }) + '\n')
  } catch (e) {
    console.error(`codex-delegate: ledger not written (${e.message})`)
  }
  const fresh = Math.max(0, input - cached) + output
  if (reply) console.log(reply)
  else if (failed) console.log('[codex error] ' + errMsg + '\n' + err.trim().split('\n').slice(-10).join('\n'))
  console.log(`---\n[codex ${model} effort=${effort} tier=${tier} mode=${mode} ok=${!failed}: input=${input} cached=${cached} output=${output} fresh=${fresh} time=${Math.round(ms / 1000)}s session=${session}]`)
  if (writeOn) console.log('[write mode: Codex may have changed files. Run git diff (or compare) and review every change before reporting it as done.]')
  process.exitCode = failed ? 1 : 0 // let piped output drain instead of cutting it with exit()
})
