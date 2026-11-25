#!/usr/bin/env node
// codex-status.mjs - prints one word about the Codex CLI: ok | login | missing | unknown
//   ok      `codex login status` says it is signed in
//   login   installed but not signed in
//   missing the `codex` command was not found
//   unknown anything else (the caller shows nothing)
// Needs Node 18+. It reads the local login state only; it sends no prompt.
import { spawn } from 'node:child_process'

const isWin = process.platform === 'win32'
// On Windows `codex` is a .cmd shim, which needs a shell; the arguments here are fixed.
const child = spawn('codex', ['login', 'status'], { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] })
let text = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', d => (text += d))
child.stderr.on('data', d => (text += d))

let done = false
const finish = word => {
  if (done) return
  done = true
  console.log(word)
  process.exitCode = 0
}

child.on('error', () => finish('missing'))
const timer = setTimeout(() => {
  child.kill()
  finish('unknown')
}, 15000)

child.on('close', code => {
  clearTimeout(timer)
  const t = text.toLowerCase()
  if (/not recognized|command not found|no such file|enoent/.test(t)) finish('missing')
  else if (/not (logged|signed) in|no credentials|not authenticated/.test(t)) finish('login')
  else if (code === 0 && /(logged|signed) in/.test(t)) finish('ok')
  else finish('unknown')
})
