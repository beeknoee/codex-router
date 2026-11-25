// A row of the table: one model's token use in this session.
// fresh  = tokens the provider counts as new (Claude: input + cache write + output;
//          Codex: input - cached + output). cached = tokens read from cache.
export type Row = {
  label: string
  calls: number
  fresh: number
  cached: number
  out: number
}

// One usage-limit window of Codex: percent used, its length in minutes, when it starts again (ms).
export type Win = { used: number; minutes: number; resetsAt: number }

// How much of Codex's limits is used: p is the 5 hour window, s the weekly one. at = 0: unknown.
export type Limits = { at: number; plan: string; p?: Win | undefined; s?: Win | undefined }

export type Stats = { claude: Row[]; codex: Row[]; at: number; chain?: number }

declare module 'claude-code' {
  interface PluginState {
    'codex-router': { stats: Shaped<Stats>; pinned: Shaped<boolean>; codex: Shaped<string>; write: Shaped<boolean>; off: Shaped<string>; guard: Shaped<boolean>; priority: Shaped<boolean>; limits: Shaped<Limits> }
  }
}
