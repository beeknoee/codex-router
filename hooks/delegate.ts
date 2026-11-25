// The `codex_delegate` tool's pieces: Claude hands one job to the Codex CLI by tier.
// register.tsx hooks it; bin/codex-delegate.mjs runs Codex (read-only unless the user's
// write switch is on) and writes the token ledger.

export const TOOL = 'mcp__codex-router__codex_delegate'

export const DESCRIPTION = `Hand work to the Codex CLI to save the user's Claude quota. By default Codex can only READ: it never edits or creates files (the sandbox is read-only) and you do all the writing. Only the USER can let Codex edit files, with the switch in the chip's card; you cannot turn it on and this tool has no argument for it. The footer of every reply shows mode=read-only or mode=write. The user can also switch Codex off for every session (for example when its usage limit is nearly used up); the tool then replies that Codex is switched off and sends nothing. In that case do the job yourself and do not call the tool again unless the user turns Codex back on. The tool also pauses by itself while the 5-hour limit of Codex has 20% or less left (the user keeps that part for their own use); the reply then says it is paused and when it starts again. Do the job yourself then too, and do not retry until that time.

If the footer says mode=write, Codex may edit files in the project folder. Then you may delegate small, well-specified edits, but afterwards always run git diff (or compare the files), review every change yourself, and run the tests; a Codex edit is an unverified draft. Never give it a vague or large task in write mode. If the mode is read-only and a job needs edits, do them yourself.

Delegate by default, without waiting to be asked, whenever a job is mostly reading or drafting and you would otherwise read or reason over more than about 3k tokens: exploring or searching a repo, tracing how something works, summarizing long files, logs or diffs, triaging errors, reviewing a diff, comparing options, or drafting code, tests or docs as TEXT in the reply for you to apply. An independent second opinion also fits.

Pick the tier by difficulty:
- easy: search, listing, summarizing long files or logs, extracting data, simple drafts.
- medium: explaining code across files, reviewing a moderate diff, drafting a feature or tests with logic.
- hard: hard bugs, architecture analysis, algorithm-heavy code, an independent review of a large diff.

Do it yourself instead: anything that edits or creates files (unless write mode is on, see above), short answers, decisions and architecture, security-sensitive work, anything needing your own tools (browser, artifacts, MCP), and irreversible actions (push, send, delete, pay). Every call costs about 20k Codex input tokens of fixed overhead, so batch several questions into one call. Never put secrets (keys, passwords, .env contents) in the prompt; what Codex reads leaves the machine through OpenAI.

The prompt must be self-contained (Codex does not see this conversation): point to file paths for it to read, say exactly what to return (for example "file:line - problem" lines, or a patch as text), and end with "Reply briefly."

Codex is weaker than you: treat its answer as an unverified draft. Open the lines it cites and check that the functions and paths it names exist before relying on it or reporting it to the user, and apply any change yourself. If it is wrong or fails, do the task yourself or retry once on a higher tier.`

export const TIERS = ['easy', 'medium', 'hard'] as const
export type Tier = (typeof TIERS)[number]

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: [...TIERS], description: 'Difficulty tier: easy, medium or hard.' },
    prompt: { type: 'string', description: 'Self-contained read-only task for Codex.' },
    task: { type: 'string', description: 'Short label for the usage table.' },
    cwd: { type: 'string', description: 'Project folder Codex reads from (default: the session folder).' },
  },
  required: ['tier', 'prompt'],
}

export type DelegateInput = {
  tier?: string
  prompt?: string
  task?: string
  cwd?: string
}

// The command line for one call. The models come from the plugin's userConfig
// (`<tier>_model`, `<tier>_effort`); left out, the script's own defaults apply.
// There is no sandbox argument: the script reads the user's write switch from a file.
export function delegateArgv(
  root: string,
  ledger: string,
  session: string,
  input: DelegateInput,
  options: Record<string, string>,
): string[] {
  const tier: Tier = (TIERS as readonly string[]).includes(input.tier ?? '')
    ? (input.tier as Tier)
    : 'medium'
  const argv = [
    'node',
    `${root}/bin/codex-delegate.mjs`,
    '--tier', tier,
    '--session', session,
    '--task', input.task ?? '',
    '--ledger', ledger,
  ]
  const model = options[`${tier}_model`]
  const effort = options[`${tier}_effort`]
  if (model) argv.push('--model', model)
  if (effort) argv.push('--effort', effort)
  if (input.cwd) argv.push('--cd', input.cwd)
  // Percent of the 5 hour limit kept for the user: below it the script pauses Codex (default 20).
  if (options.reserve_percent !== undefined && options.reserve_percent !== '') {
    argv.push('--reserve', String(options.reserve_percent))
  }

  return argv
}
