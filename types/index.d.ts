// Type contract of the `stavovy-radek` mod: every value it keeps in `$.state`.
//
// The hooks module imports the value types from '../types'; `claude plugin
// validate` holds each `$.state` key the module names to this declaration.
// All values are plain JSON data (no `undefined`: absent is `null`).

/**
 * One rate-limit window, either as `$.session.usage().rateLimits` reports it
 * (the optional `resetsAt` normalised to `null` so the value stays JSON data)
 * or as the app's `get_usage` limits card lists it.
 */
export type StavovyRadekRateLimit = {
  /**
   * Window kind: `five_hour`, `seven_day`, `spend_limit` (engine), and from the
   * app also `seven_day:<Model>` for the weekly window of a single model.
   */
  kind: string
  /** 0 to 100, at most one decimal. */
  percentUsed: number
  /** ISO 8601 timestamp of the window reset, or null when not reported. */
  resetsAt: string | null
}

/**
 * What the last `session.measure` carried (diagnostics): when it arrived, the units it
 * named in `changed`, and whether an earlier measurement of this session start had
 * already been seen (false: the first one, which the mod ignores for the cache countdown).
 */
export type StavovyRadekMeasureInfo = {
  /** `$.clock.now()` when the measurement arrived. */
  atMs: number
  /** The event's `changed` units (`context`, `cost`, `rateLimits`, ...). */
  changed: string[]
  /** The `measureSeen` flag as it stood before this measurement. */
  seen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'stavovy-radek': {
      /** Main-loop model exactly as `$.session.model()` returns it; null until read. */
      model: string | null
      /**
       * Context fill, 0 to 100, as the app's composer shows it (the engine's own
       * figure only as a backup); null before the first reading.
       */
      contextPercent: number | null
      /**
       * Size of the context window the percent is counted against, in tokens, as the app's
       * `get_usage` reports it (`contextWindow`); null when not reported.
       */
      contextWindow: number | null
      /**
       * Rate-limit windows as the app's limits card shows them (the engine's
       * figures only as a backup); empty off a subscription.
       */
      rateLimits: StavovyRadekRateLimit[]
      /**
       * `$.clock.now()` at the last sign of main-loop activity: the start or the end of a
       * turn, or a `session.measure` whose cost or context moved (a model response during a
       * turn).
       * Null when unknown.
       */
      lastActivityMs: number | null
      /**
       * True once the first `session.measure` of this session start went by. That first
       * measurement names every unit it has a figure for, so it says nothing about
       * activity and is skipped; `session.start` resets the flag.
       */
      measureSeen: boolean
      /**
       * True from `turn.start` to `turn.complete` of the main loop: the cache segment then
       * carries a "turn running" note (its countdown runs from the last activity all the
       * same). `session.start` clears it.
       */
      turnRunning: boolean
      /**
       * Where the compact hint stands: `idle`, or `running` while a compaction runs (started
       * by a press, the safeguard, the person's own `/compact` or the engine) and a short
       * while after. `session.start` resets it.
       */
      compactState: 'idle' | 'running'
      /** `$.clock.now()` at the last refresh tick; null until the first refresh. */
      nowMs: number | null
      /** Project root (`$.session.root()`); null until read. */
      root: string | null
      /**
       * The GitHub URL derived from the repository's `origin` remote (`https://github.com/o/r`),
       * or null for a repository that is not on GitHub or has no remote (v0.5.0). The raw remote
       * is never kept: it can carry credentials. A value left by 0.4.0 (the raw remote) is
       * replaced at `session.start`.
       */
      remote: string | null
      /** True when `<root>/.git` is a file, i.e. the window runs in a git worktree. */
      isWorktree: boolean
      /**
       * Diagnostics : how many `session.measure` events the host delivered, the
       * first of each start included. Counts on across hot reloads.
       */
      measureCount: number
      /** Diagnostics : the last `session.measure` seen; null before any. */
      measureInfo: StavovyRadekMeasureInfo | null
      /**
       * Diagnostics : how many `turn.complete` events were delivered (a subagent's
       * included), to set against `measureCount`.
       */
      turnCount: number
    }
  }
}
