# codex-router

A Claude Code plugin that hands work (read-only by default) to the [Codex CLI](https://github.com/openai/codex) so you spend less of your Claude quota, and shows how each session splits between Claude and Codex.

English · [Tiếng Việt](README.vi.md)

> **Status: v0.2, early.** Written and tested on one Windows 11 machine with the Claude Desktop Code tab (Claude Code engine 2.1.330) and Codex CLI 0.163. The Node scripts are tested end to end. The `codex_delegate` tool has not yet been exercised by anyone other than its author, and the chip UI is only checked by eye on that one setup. Expect rough edges.

## What you get

- **`codex_delegate` tool.** Claude calls it with a difficulty tier (`easy`, `medium`, `hard`) and a self-contained prompt. Codex answers and the reply comes back with a footer line of token counts. The tool's description carries the delegation rules, so you do not need to edit any `CLAUDE.md`.
- **A `Claude % · Codex %` chip** in the prompt footer, in the row of the model and effort pickers. Click it to open a card above the prompt with a per-model table (new tokens, cache, calls) and, to its right, two lines: the share when cache reads count too, and how many earlier sessions are included. Under the title of the card sit four switches and a **✕** that closes it: **Codex bật / tắt** turns Codex off for **every** session at once, **Ưu tiên Codex** makes Claude hand Codex more work, the hard jobs included (see below), **Tự tắt ≤20%** lets the limit turn it off by itself (see below), and **Đọc / Sửa** lets Codex edit files in this session (see [Safety](#safety); read-only by default). Under the table the card shows **how much of Codex's usage limit is left**: a bar for the 5-hour window and one for the week, with the time until each starts again. Click **✕** or the chip again to close the card.
- **A faint note beside the chip** when Codex is not signed in (`(chưa đăng nhập)`) or not installed (`(chưa cài Codex)`), checked once a minute with `codex login status`. Nothing is sent to a model for this check.
- **Codex priority.** While the **Ưu tiên Codex** switch is on (per session, like **Đọc / Sửa**), every prompt you send carries a short hidden note for Claude (your own words are not changed; the note is only added while Codex is on): hand Codex every separable read, search, analysis or drafting job from about 1k tokens, and give it the hard ones too with the hard tier. Claude still decides, makes the edits (unless write mode is on) and checks the lines Codex cites. It costs about 90 tokens per prompt, and the delegations it causes use your Codex limit faster.
- **Automatic pause, with its own switch.** While the 5-hour limit has **20% or less left**, the **Codex** switch in the card turns itself **off** and `codex_delegate` sends nothing to Codex, so you keep some for your own use. Claude does the job itself. When the window resets, the switch turns itself back on. The **Tự tắt ≤20%** switch next to it decides whether this happens at all: switch it off and Codex is never turned off by the limit, so you can use it down to zero (this is also the way to override a pause, for example right after you changed Codex account). A Codex switch you turned off yourself is never turned on by the plugin. Change the 20 with the plugin option `reserve_percent` (0 = no guard). The figures come from the limits Codex writes in its own session files (`~/.codex/sessions`), so they are as fresh as the last Codex turn on this machine, from the Codex app, the CLI or this plugin.
- **`/codex-router`**, which prints the same breakdown, and the limits, into the chat.
- **`/codex-history`**, which prints the saved history by day and by session. Each session's totals are saved to `~/.claude/codex-router/history/<session-id>.json`, rewritten as the session goes (at most every 10 seconds). A session that was resumed or moved to another folder counts once.
- **A local ledger**, `~/.claude/codex-router/ledger.jsonl`, one JSON line per Codex call.

## How work is handed to Codex

There is no automatic router. Claude decides, guided by the tool description:

1. **Claude reads the rules** in the `codex_delegate` description. It is told to delegate **by default** any job that is mostly reading or drafting and would take it more than about 3k tokens: exploring or searching a repo, tracing how something works, summarizing long files, logs or diffs, triaging errors, reviewing a diff, comparing options, or drafting code and tests as *text* for itself to apply.
2. **It picks a tier** and writes a self-contained prompt (Codex does not see the conversation).
3. **The plugin runs the call:** `node bin/codex-delegate.mjs` maps the tier to a model and effort, runs `codex exec --json` in the project folder, reads the token usage from the event stream, appends a line to the ledger and returns Codex's final message plus a footer.
4. **Claude checks the answer** against the real files before relying on it, and does all the editing itself.

| Tier | Default model | Effort | Meant for |
| --- | --- | --- | --- |
| `easy` | `gpt-6-luna` | low | search, listing, summarizing long files or logs, extracting data, simple drafts |
| `medium` | `gpt-6.2-astra` | medium | explaining code across files, reviewing a moderate diff, drafting a feature or tests |
| `hard` | `gpt-6.2-sol` | high | hard bugs, architecture analysis, algorithm-heavy code, reviewing a large diff |

Claude is told **not** to delegate (unless you switched write mode on): edits, short answers, decisions and architecture, security-sensitive work, anything needing its own tools, and irreversible actions (push, send, delete, pay).

Every Codex call carries about 20k input tokens of fixed overhead, so the tool description asks Claude to batch small questions into one call. Because Claude decides, it may delegate less than you would like; tell it to delegate if you want more.

## Safety

- **Codex is read-only by default.** The script runs `-s read-only`, and every prompt starts with a line telling Codex not to create, edit, move or delete files and to show changes as a patch in its reply. We checked this by asking Codex to create a file; it refused and the folder stayed empty.
- **Only you can let Codex edit.** The switch in the chip's card sets write mode for that one session: the script then runs `-s workspace-write` (Codex may write inside the project folder only, no network) and tells Codex to keep changes small, not to delete files or run `git commit`/`push`/`reset`, and to list what it changed. The switch is stored as a file, `~/.claude/codex-router/write-mode/<session-id>.txt`, that the script reads on every call. The tool has no argument for it, so Claude cannot turn it on. Every reply's footer shows `mode=read-only` or `mode=write`; in write mode Claude is told to run `git diff`, review each change and run the tests, and to give Codex only small, well-specified edits. Work in a git repository with a clean tree when you switch it on, so a change you dislike is one `git checkout` away.
- **Codex is treated as an unverified draft.** Claude is told to open the lines Codex cites and check that the functions and paths exist before using or reporting its answer.
- **On Windows the script refuses `" % & | < > ^` and backticks** in the model, effort and folder arguments, because `codex` is a `.cmd` shim that needs a shell. The prompt itself goes through stdin, so it can contain anything.
- **Privacy:** whatever Codex reads leaves your machine through OpenAI. Do not use the plugin on projects that must not. Claude is told never to put secrets in a prompt.

## Requirements

- **Claude Code with plugin modules.** The Claude Desktop Code tab, or the CLI, at engine version **2.1.330 or newer**. (A `claude` on your `PATH` can be older than the one the Desktop app bundles; the app's own version is what counts.)
- **Node.js 18 or newer** on `PATH`.
- **Codex CLI on `PATH` and signed in:**

  ```
  npm i -g @openai/codex
  codex login
  ```

- **Models your Codex account can use.** Some accounts cannot use every model the CLI lists; see [Troubleshooting](#troubleshooting).

## Install

**Claude Desktop (app).** Click **+** next to the prompt box, choose **Plugins**, **Add marketplace**, enter `beeknoee/codex-router`, then **Add plugin** and pick `codex-router`. Start a new session.

**Terminal.** `/plugin` does not run inside the Desktop app, so use a shell:

```
claude plugin marketplace add beeknoee/codex-router
claude plugin install codex-router@codex-router
```

This installs at the user scope; the plugin then loads in every session you start, including Desktop sessions on the same machine.

**From a local folder** (to try it before publishing, or to develop it):

```
claude plugin marketplace add "D:\path\to\codex-router"
claude plugin install codex-router@codex-router
```

or, for one session only: `claude --plugin-dir "D:\path\to\codex-router"`.

**A private repository** installs only for people who can read it on GitHub and whose machine already has a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Configure

The model and reasoning effort of each tier are plugin options: `easy_model`, `easy_effort`, `medium_model`, `medium_effort`, `hard_model`, `hard_effort`. Set them from the plugin's settings screen, or at install time:

```
claude plugin install codex-router@codex-router --config medium_model=gpt-6-astra --config medium_effort=medium
```

Use models that your own `codex` can run. `codex exec -m <model> "hi"` is a quick way to check one.

## Use it

1. Start a session in any project and work as usual. Ask Claude to use Codex when you want it to (`delegate the log triage to Codex`), or just let it decide.
2. Look at the footer. After the first turn it shows `Claude 94% · Codex 6%`.
3. Click the chip for the table, or type `/codex-router` to print it in the chat.

The share is counted on **new tokens**: uncached input, cache writes and output. Cache reads are shown separately, and the card adds one line with the share when cache reads count too (Claude's sessions read far more from cache than Codex's, so the two shares can differ a lot). Claude subagents are not counted yet.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Codex call fails with `model_not_found` ("not supported when using Codex with a ChatGPT account") | Your account cannot use that model. Run `codex login` again, or change the tier's model in the plugin settings. Models can differ between accounts and plans. |
| `(chưa đăng nhập)` beside the chip | `codex login status` says you are not signed in. Run `codex login`. |
| `(chưa cài Codex)` beside the chip | The `codex` command is not on `PATH`. Install it and restart Claude. |
| Nothing appears in the footer | The plugin is not loaded. Start a new session or run `/reload-plugins`. Check that your Claude Code engine is 2.1.330 or newer. |
| `codex_delegate` fails right away | Node 18+ must be on `PATH` for the process that runs Claude. |
| `codex_delegate` replies that Codex is switched off or paused | Switched off: the **Codex bật / tắt** switch in the card is off; turn it on. Paused: the 5-hour limit has 20% or less left (the share you keep for yourself); it starts again when the window resets. Change the share with the `reserve_percent` option, 0 = never pause. |
| The chip shows `Codex 0%` after delegating, or drops back to 0% | The call may have failed before using tokens (those are not counted). Codex calls are matched to the session by its id; the plugin also follows ids it finds in the transcript (the footer of each Codex reply carries `session=<id>`), so a resume, a compact (which starts a new session with a new transcript) or a move to a folder keeps them. The Claude side reads the transcripts of those earlier sessions too, once per message id, so both sides cover the whole chain and a compact does not reset the share. A `/clear` starts a fresh conversation, so the count starts again. |

## Known limitations

- Tested on Windows only. The scripts use `shell` only on Windows and should work elsewhere, but that is not tested.
- The chip text, the card and the login note are in Vietnamese; they are not localized yet.
- The desktop app draws a plugin button as a native pill, so the chip has a faint background that a plugin cannot remove. A floating popup next to the chip is not possible in the desktop footer, which is why the card opens above the prompt.
- Claude subagents are not counted.
- `codex login status` shows whether you are signed in, not whether a token has expired or a model is allowed. Those only show up when a call fails.

## Development

```
.claude-plugin/plugin.json        manifest and the tier options (userConfig)
.claude-plugin/marketplace.json   makes this repository installable as a marketplace
hooks/hooks.json                  names the hooks module
hooks/register.tsx                chip, card, /codex-router, usage counting, tool hook
bin/codex-limits.mjs              reads the 5-hour and weekly Codex limits from its session files
hooks/delegate.ts                 the tool's description, schema and command line
bin/codex-delegate.mjs            runs one read-only Codex call and writes the ledger
bin/codex-status.mjs              reports ok | login | missing | unknown for Codex
types/index.d.ts                  state contract for the plugin's stored values
```

Validate with the Claude Code build you target (the Desktop app bundles its own):

```
claude plugin validate .
```

To reload edits while developing, add this folder to `CLAUDE_CODE_PLUGIN_DIRS` (for the Desktop app, in the `env` block of `~/.claude/settings.json`), set `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, and run `/reload-plugins` after a change.

## License

[MIT](LICENSE).
