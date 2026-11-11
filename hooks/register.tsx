import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { StavovyRadekMeasureInfo, StavovyRadekRateLimit } from '../types'
import {
  buildSegments,
  effectiveGuardMode,
  errorText,
  firstTextBlock,
  githubUrl,
  isFresh,
  isGuardDue,
  isPersonPrompt,
  joinPath,
  parseAppUsage,
  readSettings,
  usageSource,
} from './line'
import type { CompactState, LineInput, Segment, Settings } from './line'

// Status line for Claude Code windows in the desktop app.
//
// Why a mod and not settings.json "statusLine": the desktop app never runs the CLI status line
// command, so a status line configured there is never drawn in the app.
//
// One band above the prompt (ui.render on AbovePrompt):
//   model | ctx 77 % / 400k | cache 18 min | 5h 41 %^ . 2h 13m | week 22 %^ . 5d 11h
//   | Fable wk 12 %^ | project | wt name
// The render hook only READS atoms (writing $.state while drawing is refused).
// Several writers fill them: session.measure (engine context + limits, and the last activity
// when cost or context moved: a model response inside a long turn), turn.start / turn.complete
// (last activity of the main loop) and a 30 s tick started in session.start ("now", so the cache
// countdown moves without any event, plus the engine's usage). The project, the model, the
// worktree and the app's own numbers are re-read only on every 4th tick (about 2 min) and at the
// start: the fast tick needs the clock and what is cached. A failed read never throws out of a
// hook: the previous value stays and the band keeps drawing.
//
// Options (manifest `userConfig`, parsed by readSettings): the safeguard mode (off by default),
// the flush text, the prompt cache lifetime in minutes and the language of the labels.
//
// Where limits and context come from: for some accounts the engine's `usage()` carries no rate
// limits and counts context against a 1 M window, so the numbers shown in the app (limits card,
// composer) are read from the app itself: `$.mcp.call('ccd_session_mgmt', 'get_usage')`, at
// session start, on every 4th tick and after each main-loop turn. A reading younger than 5 min
// wins: the engine's figures do not overwrite the field it supplied (limits and context are
// judged separately). Older or failing, the engine's figures apply as before.
//
// session.measure and turn.complete also count themselves (measureCount, measureInfo, turnCount)
// and writeDiag puts the three into pas.json, to find out whether and with what `changed` the
// desktop app raises session.measure during a turn.
//
// The compact hint at the end of the band is a button. A press runs the real `/compact` through
// `$.command.run` (the engine queues it behind a running turn). Other ways were refused live:
// the bare word "compact" in the chat, `$.session.compact` ("not available in a headless session
// yet") and `$.prompt.submit('/compact')` ("a text beginning with / would run a command as the
// user"). The one compact the mod starts without a press is the safeguard (see maybeStartGuard),
// which is off unless the options switch it on.
//
// Scratch folder: unavailable in this build's API, so it has no segment.

const REFRESH_MS = 30000
/** The slow reads (project, model, the app) happen on every Nth tick (4 x 30 s = about 2 min). */
const APP_EVERY_TICKS = 4
/** MCP server and tool of the app's own usage numbers. */
const APP_SERVER = 'ccd_session_mgmt'
const APP_TOOL = 'get_usage'

const modelAtom = atom({ plugin: 'stavovy-radek', key: 'model' } as const, null)
const contextAtom = atom({ plugin: 'stavovy-radek', key: 'contextPercent' } as const, null)
const contextWindowAtom = atom({ plugin: 'stavovy-radek', key: 'contextWindow' } as const, null)
const limitsAtom = atom({ plugin: 'stavovy-radek', key: 'rateLimits' } as const, [])
const lastAtom = atom({ plugin: 'stavovy-radek', key: 'lastActivityMs' } as const, null)
const nowAtom = atom({ plugin: 'stavovy-radek', key: 'nowMs' } as const, null)
const measureSeenAtom = atom({ plugin: 'stavovy-radek', key: 'measureSeen' } as const, false)
const turnRunningAtom = atom({ plugin: 'stavovy-radek', key: 'turnRunning' } as const, false)
const compactStateAtom = atom({ plugin: 'stavovy-radek', key: 'compactState' } as const, 'idle')
const rootAtom = atom({ plugin: 'stavovy-radek', key: 'root' } as const, null)
const remoteAtom = atom({ plugin: 'stavovy-radek', key: 'remote' } as const, null)
const worktreeAtom = atom({ plugin: 'stavovy-radek', key: 'isWorktree' } as const, false)
// Diagnostic counters (no effect on the band): how many session.measure and turn.complete events
// the host really delivers, and what the last measure carried. writeDiag copies them into pas.json.
const measureCountAtom = atom({ plugin: 'stavovy-radek', key: 'measureCount' } as const, 0)
const measureInfoAtom = atom({ plugin: 'stavovy-radek', key: 'measureInfo' } as const, null)
const turnCountAtom = atom({ plugin: 'stavovy-radek', key: 'turnCount' } as const, 0)

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// One writer per atom, written out: `claude plugin validate` reads the atom handed to
// `read` / `update` at the call site, so a generic helper taking the atom is refused.
// Each writes only when the value differs, so an unchanged tick redraws nothing.
async function setModel($: EngineInterface, value: string | null): Promise<void> {
  if (!same(await read($, modelAtom), value)) await update($, modelAtom, () => value)
}
async function setContext($: EngineInterface, value: number | null): Promise<void> {
  if (!same(await read($, contextAtom), value)) await update($, contextAtom, () => value)
}
async function setContextWindow($: EngineInterface, value: number | null): Promise<void> {
  if (!same(await read($, contextWindowAtom), value)) await update($, contextWindowAtom, () => value)
}
async function setLimits($: EngineInterface, value: StavovyRadekRateLimit[]): Promise<void> {
  if (!same(await read($, limitsAtom), value)) await update($, limitsAtom, () => value)
}
async function setLast($: EngineInterface, value: number | null): Promise<void> {
  if (!same(await read($, lastAtom), value)) await update($, lastAtom, () => value)
}
async function setNow($: EngineInterface, value: number | null): Promise<void> {
  if (!same(await read($, nowAtom), value)) await update($, nowAtom, () => value)
}
async function setMeasureSeen($: EngineInterface, value: boolean): Promise<void> {
  if (!same(await read($, measureSeenAtom), value)) await update($, measureSeenAtom, () => value)
}
async function setTurnRunning($: EngineInterface, value: boolean): Promise<void> {
  if (!same(await read($, turnRunningAtom), value)) await update($, turnRunningAtom, () => value)
}
async function setCompactState($: EngineInterface, value: CompactState): Promise<void> {
  if (!same(await read($, compactStateAtom), value)) await update($, compactStateAtom, () => value)
}
async function setRoot($: EngineInterface, value: string | null): Promise<void> {
  if (!same(await read($, rootAtom), value)) await update($, rootAtom, () => value)
}
async function setRemote($: EngineInterface, value: string | null): Promise<void> {
  if (!same(await read($, remoteAtom), value)) await update($, remoteAtom, () => value)
}
async function setWorktree($: EngineInterface, value: boolean): Promise<void> {
  if (!same(await read($, worktreeAtom), value)) await update($, worktreeAtom, () => value)
}

// Diagnostic writers. The counters go up by one inside `update`, which reads and writes with a
// version check, so two events arriving together are both counted.
async function bumpMeasureCount($: EngineInterface): Promise<void> {
  await update($, measureCountAtom, (n) => n + 1)
}
async function setMeasureInfo($: EngineInterface, value: StavovyRadekMeasureInfo): Promise<void> {
  if (!same(await read($, measureInfoAtom), value)) await update($, measureInfoAtom, () => value)
}
async function bumpTurnCount($: EngineInterface): Promise<void> {
  await update($, turnCountAtom, (n) => n + 1)
}

async function loadInput($: EngineInterface, settings: Settings): Promise<LineInput> {
  const [
    model,
    contextPercent,
    contextWindow,
    rateLimits,
    lastActivityMs,
    nowMs,
    root,
    remote,
    isWorktree,
    isTurnRunning,
    compactState,
  ] = await Promise.all([
    read($, modelAtom),
    read($, contextAtom),
    read($, contextWindowAtom),
    read($, limitsAtom),
    read($, lastAtom),
    read($, nowAtom),
    read($, rootAtom),
    read($, remoteAtom),
    read($, worktreeAtom),
    read($, turnRunningAtom),
    read($, compactStateAtom),
  ])
  return {
    model,
    contextPercent,
    contextWindow,
    rateLimits,
    lastActivityMs,
    nowMs,
    root,
    remote,
    isWorktree,
    isTurnRunning,
    compactState,
    settings,
  }
}

// Diagnostic: where `_local/stavovy-radek/diag-<session id>.on` exists under the working
// directory, the tick writes the text the band shows plus a render counter, so the mod can be
// verified from a file instead of reading the screen. Nowhere else is anything written: the marker
// names one session, so the many windows opened in the same working folder do not rewrite one
// shared file every tick, and a failure here never reaches the band. The marker is looked for at
// the start and on the slow tick (diagOn), not on every tick.
const DIAG_DIR = '_local/stavovy-radek'

/** True when this very session asked for diagnostics (see above); never rejects. */
async function isDiagOn($: EngineInterface): Promise<boolean> {
  try {
    if (!(await $.fs.exists(DIAG_DIR))) return false
    return await $.fs.exists(`${DIAG_DIR}/diag-${await $.session.id()}.on`)
  } catch {
    return false
  }
}
let renderCount = 0
let lastRenderMs: number | null = null
/** The result of the last look for the marker file. */
let diagOn = false

// Bookkeeping of the app readings, in module variables (not $.state: the render
// hook does not need them). A hot reload re-evaluates the module and session.start
// resets them, so a new session never inherits the freshness of an old one.
/** `$.clock.now()` of the last app reading that carried at least one limit window. */
let appLimitsReadMs: number | null = null
/** `$.clock.now()` of the last app reading that carried the context percent. */
let appContextReadMs: number | null = null
/** First 120 characters of the last app call's failure; null when it worked. */
let appError: string | null = null
/** Ticks since the session started; the slow reads happen on every APP_EVERY_TICKS-th. */
let tickCount = 0

/** The slash command the compact hint runs (`$.command.run`), without the slash. */
const COMPACT_COMMAND = 'compact'
/**
 * After a press (or when the engine raises `session.compact`) the hint stays "compacting" until
 * the compaction has settled; this is the fallback for a compact that never reports back (or is
 * queued behind a turn that never ends). Long on purpose: a slow or queued compact must not bring
 * the button back early.
 */
const COMPACT_FALLBACK_MS = 15 * 60 * 1000
/** Once the compaction has settled, the hint stays text this much longer: the context figure lags behind. */
const COMPACT_SETTLE_MS = 45 * 1000
/** `$.clock.now()` when the hold ends; null when none is held. */
let compactReleaseMs: number | null = null
/** How many `session.compact` hooks are waiting for the engine's answer right now. */
let compactInFlight = 0
/** Diagnostics: how often the command was run, and what the last attempt came to. */
let compactAttempts = 0
let compactLastResult: string | null = null

// The safeguard's bookkeeping, module variables like the rest: a hot reload starts it over, and an
// idle period that began before a reload is not met again unless its activity time is known.
/** 'flushing': the flush text was sent and the compact waits for the end of that very turn. */
let guardPhase: 'idle' | 'flushing' = 'idle'
/** The turn id of the flush turn once its `turn.start` was seen; null before. */
let guardTurnId: string | null = null
/** `$.clock.now()` when the flush text was sent. */
let guardStartedMs: number | null = null
/**
 * True while the safeguard may start. It goes false when it starts and true again only when the
 * person submits a prompt of their own (prompt.submit): a window nobody comes back to is handled
 * once, not once an hour all night (each go costs a compact, and a flush turn too).
 */
let guardArmed = true
/** Diagnostics: how often the safeguard started, and what the last go came to. */
let guardAttempts = 0
let guardLastResult: string | null = null
/**
 * Diagnostics: the origin kind of the last prompt submission (with "(meta)" when the person does
 * not see it as typed). The engine's kinds differ by surface, and the types cannot say which one a
 * typed message carries in a given app, so the diagnostics file shows it.
 */
let lastPromptKind: string | null = null
/** A flush turn that has not ended after this long is given up on: no compact follows. */
const GUARD_FLUSH_TIMEOUT_MS = 20 * 60 * 1000

function resetAppBookkeeping(): void {
  appLimitsReadMs = null
  appContextReadMs = null
  appError = null
  tickCount = 0
  compactReleaseMs = null
  diagOn = false
  guardPhase = 'idle'
  guardTurnId = null
  guardStartedMs = null
  guardArmed = true
}

/**
 * The compact hint's press: runs the real `/compact` through `$.command.run`, as if the person
 * typed it into the prompt box. Neither `$.session.compact` ("not available in a headless session
 * yet") nor `$.prompt.submit('/compact')` (refused: "a text beginning with / would run a command
 * as the user") works in the desktop app. The engine queues the command and runs it once the
 * session is idle, so a press during a turn is fine. While the hold lasts the hint is text, so a
 * second press cannot queue a second compact. The hold ends when the `session.compact` hook sees
 * the compaction settle; the fallback is long. A press made during a turn is queued, so the
 * command's return says nothing about the compaction and the hold is left to the hook. Never
 * rejects.
 */
async function requestCompact($: EngineInterface): Promise<void> {
  try {
    if ((await read($, compactStateAtom)) !== 'idle') return
    const isQueued = (await read($, turnRunningAtom)) === true
    compactAttempts += 1
    const attempt = compactAttempts
    compactLastResult = 'running'
    compactReleaseMs = (await $.clock.now()) + COMPACT_FALLBACK_MS
    await setCompactState($, 'running')
    const result = await $.command.run({ command: COMPACT_COMMAND })
    // A press made after the hold ran out is a newer attempt: this late return must not shorten its hold.
    if (attempt !== compactAttempts) return
    compactLastResult = `done: ${errorText(result.text ?? 'no output', 300)}`
    // The command has returned. When nothing is compacting any more and the command was not
    // queued behind a turn, keep the hint text a little longer for the context figure to catch up;
    // otherwise the session.compact hook decides.
    if (compactInFlight === 0 && !isQueued) compactReleaseMs = (await $.clock.now()) + COMPACT_SETTLE_MS
  } catch (error) {
    compactLastResult = `refused: ${errorText(error, 400)}`
    compactReleaseMs = null
    try {
      await setCompactState($, 'idle')
    } catch {
      // keep the band as it was
    }
  }
}

/** Gives the hint back as a button once the hold has run out. Never rejects. */
async function releaseCompactHold($: EngineInterface): Promise<void> {
  try {
    if (compactReleaseMs === null) return
    if ((await $.clock.now()) < compactReleaseMs) return
    compactReleaseMs = null
    await setCompactState($, 'idle')
  } catch {
    // keep the band as it was
  }
}

/**
 * The safeguard, step 1, called from the tick; it does nothing in mode `off` (the default) and
 * whenever the cache lives under 30 minutes. A window left alone until the prompt cache has
 * little left (10 of 60 minutes, and at least 2), whatever the context fill, is dealt with
 * before the cache goes cold:
 *  - mode `compact`: the real `/compact` runs at once;
 *  - mode `flush-then-compact`: the flush text is submitted as the person's own message (the
 *    flush turn renews the cache and lets the model save what it should), and step 2
 *    (continueGuard) compacts after that turn if it ended with an answer.
 * Held back when: a turn runs, a compact is under way, the figures are not the desktop app's (a -p
 * run or a CLI session has no such figures), or the safeguard already went and the person has not
 * written since (guardArmed). Never rejects.
 */
async function maybeStartGuard($: EngineInterface, settings: Settings): Promise<void> {
  try {
    const mode = effectiveGuardMode(settings)
    if (mode === 'off') return
    const nowMs = await $.clock.now()
    if (guardPhase === 'flushing') {
      // The flush turn never started or never ended: give up, nothing is compacted.
      if (guardStartedMs !== null && nowMs - guardStartedMs > GUARD_FLUSH_TIMEOUT_MS) {
        guardLastResult = 'gave up: the flush turn did not end in time'
        guardPhase = 'idle'
        guardTurnId = null
      }
      return
    }
    if (usageSource(appLimitsReadMs, appContextReadMs, nowMs) !== 'app') return
    const input = await loadInput($, settings)
    if (input.compactState === 'running') return
    if (
      !isGuardDue(
        input.contextPercent,
        input.lastActivityMs,
        nowMs,
        input.isTurnRunning === true,
        settings,
      )
    ) {
      return
    }
    if (!guardArmed || guardPhase !== 'idle') return
    guardArmed = false
    guardAttempts += 1
    if (mode === 'compact') {
      guardLastResult = 'compact requested'
      await requestCompact($)
      return
    }
    guardPhase = 'flushing'
    guardTurnId = null
    guardStartedMs = nowMs
    guardLastResult = 'flush word sent'
    // Not awaited to the end of its turn: a prompt "runs once the session is idle".
    void $.prompt.submit({ text: settings.flushText, asUser: true }).catch((error: unknown) => {
      guardLastResult = `refused: ${errorText(error, 400)}`
      guardPhase = 'idle'
      guardTurnId = null
    })
  } catch (error) {
    guardLastResult = `refused: ${errorText(error, 400)}`
    guardPhase = 'idle'
    guardTurnId = null
  }
}

/**
 * The safeguard, step 2 (flush-then-compact): the flush turn it started has ended. The real
 * `/compact` runs now, through the same path as the button (the band shows "compacting"), but only
 * when that turn ended with an answer. An interrupted turn, an error and a refusal compact nothing.
 * Never rejects.
 */
async function continueGuard($: EngineInterface, turnId: string, reason: string): Promise<void> {
  try {
    if (guardPhase !== 'flushing' || guardTurnId === null || turnId !== guardTurnId) return
    guardPhase = 'idle'
    guardTurnId = null
    if (reason !== 'answer') {
      guardLastResult = `flush turn ended: ${reason}, no compact`
      return
    }
    guardLastResult = 'flush turn done: compact requested'
    await requestCompact($)
  } catch (error) {
    guardLastResult = `refused: ${errorText(error, 400)}`
  }
}

/**
 * Bookkeeping for a prompt submission (the prompt.submit hook calls it and passes the prompt on
 * unchanged whatever happens here): a prompt of the person's own re-arms the safeguard and
 * cancels a compact that waits for a flush turn. A plugin's prompt (the safeguard's own flush text
 * included), another session's message, a wake-up or a notification is not the person. Synchronous
 * and free of side effects beyond the module variables, so it can neither block nor alter a prompt.
 */
function notePrompt(origin: unknown, isMeta: boolean): void {
  const kind = typeof origin === 'object' && origin !== null ? (origin as { kind?: unknown }).kind : undefined
  lastPromptKind = `${typeof kind === 'string' ? kind : 'none'}${isMeta ? ' (meta)' : ''}`
  if (!isPersonPrompt(origin, isMeta)) return
  guardArmed = true
  if (guardPhase === 'flushing') {
    guardLastResult =
      guardTurnId === null
        ? 'stood down: the person came back before the flush turn'
        : 'user returned during flush: no compact'
    guardPhase = 'idle'
    guardTurnId = null
  }
}

async function writeDiag($: EngineInterface, settings: Settings): Promise<void> {
  try {
    if (!diagOn) return
    const input = await loadInput($, settings)
    const line = buildSegments(input)
      .map((s) => s.text)
      .join(' │ ')
    const [measureCount, measureInfo, turnCount] = await Promise.all([
      read($, measureCountAtom),
      read($, measureInfoAtom),
      read($, turnCountAtom),
    ])
    await $.fs.write(
      `${DIAG_DIR}/pas.json`,
      JSON.stringify({
        nowMs: input.nowMs,
        line,
        renderCount,
        lastRenderMs,
        source: usageSource(appLimitsReadMs, appContextReadMs, input.nowMs),
        mcpError: appError,
        windows: input.rateLimits,
        contextPercent: input.contextPercent,
        contextWindow: input.contextWindow ?? null,
        hasRemote: input.remote !== null && input.remote !== '',
        isWorktree: input.isWorktree,
        lastActivityMs: input.lastActivityMs,
        isTurnRunning: input.isTurnRunning === true,
        measureCount,
        measureInfo,
        turnCount,
        compactState: input.compactState ?? 'idle',
        compactAttempts,
        compactLastResult,
        compactInFlight,
        guardMode: effectiveGuardMode(settings),
        cacheTtlMinutes: settings.cacheTtlMinutes,
        language: settings.language,
        guardPhase,
        guardAttempts,
        guardLastResult,
        guardArmed,
        lastPromptKind,
      }),
    )
  } catch {
    // diagnostics are best effort
  }
}

function normalizeLimits(limits: readonly SessionRateLimit[]): StavovyRadekRateLimit[] {
  return limits.map((l) => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    resetsAt: l.resetsAt ?? null,
  }))
}

/**
 * The engine's context and limits, as the backup source: a field the app read
 * within the last 5 min is left alone. When the time cannot be read, the engine
 * writes (the old behaviour).
 */
async function storeEngineUsage(
  $: EngineInterface,
  percent: number | undefined,
  limits: readonly SessionRateLimit[],
): Promise<void> {
  let nowMs: number | null = null
  try {
    nowMs = await $.clock.now()
  } catch {
    nowMs = null
  }
  if (nowMs === null || !isFresh(appContextReadMs, nowMs)) {
    await setContext($, percent ?? null)
    // The engine's percent is against the model's window, not the app's setting: no size is shown.
    await setContextWindow($, null)
  }
  if (nowMs === null || !isFresh(appLimitsReadMs, nowMs)) {
    await setLimits($, normalizeLimits(limits))
  }
}

/**
 * Reads the numbers the app itself shows (limits card, composer) and stores them.
 * Never rejects: a failed call is recorded in `appError` and the engine's
 * figures stay in force.
 */
async function refreshAppUsage($: EngineInterface): Promise<void> {
  try {
    const result = await $.mcp.call(APP_SERVER, APP_TOOL)
    const text = firstTextBlock(result.content)
    if (result.isError) {
      appError = errorText(text ?? 'tool reported an error')
      return
    }
    if (text === null) {
      appError = 'reply has no text block'
      return
    }
    const usage = parseAppUsage(text)
    const nowMs = await $.clock.now()
    let isUsable = false
    if (usage.windows.length > 0) {
      await setLimits($, usage.windows)
      appLimitsReadMs = nowMs
      isUsable = true
    }
    if (usage.contextPercent !== null) {
      await setContext($, usage.contextPercent)
      // The size is the app's setting; a reply without it clears an old one (the segment drops it).
      await setContextWindow($, usage.contextWindow)
      appContextReadMs = nowMs
      isUsable = true
    }
    appError = isUsable ? null : 'reply carries no usable numbers'
  } catch (error) {
    appError = errorText(error)
  }
}

/**
 * Makes sure the stored remote is what this version keeps: the derived GitHub URL or null. An
 * earlier version stored the raw git remote (which can carry credentials) and `$.state` survives a
 * reload, so the stored value is checked and, if it is anything else, replaced by what
 * `githubUrl` makes of it. Never rejects.
 */
async function sanitizeStoredRemote($: EngineInterface): Promise<void> {
  try {
    const stored: unknown = await read($, remoteAtom)
    const safe = typeof stored === 'string' ? githubUrl(stored) : null
    if (stored !== safe) await update($, remoteAtom, () => safe)
  } catch {
    // keep the band as it was
  }
}

/**
 * The slow reads: the model, the project root, the GitHub URL of the repository, the worktree flag
 * and whether diagnostics were asked for. Called at the start and on every APP_EVERY_TICKS-th tick.
 * Never rejects: a failure keeps the old value.
 */
async function refreshProject($: EngineInterface): Promise<void> {
  try {
    await setModel($, await $.session.model())
  } catch {
    // keep the previous model
  }

  let root: string | null = null
  try {
    root = await $.session.root()
    await setRoot($, root)
  } catch {
    try {
      root = (await read($, rootAtom)) ?? null
    } catch {
      root = null
    }
  }
  try {
    const repo = await $.session.repo()
    // Only the derived GitHub URL is kept; a raw remote may carry credentials.
    await setRemote($, repo === null ? null : githubUrl(repo.remote))
  } catch {
    // keep the previous remote
  }
  if (root !== null && root !== '') {
    let isWorktree = false
    try {
      // In a git worktree `.git` is a file ("gitdir: ..."), in the main tree a folder.
      isWorktree = (await $.fs.stat(joinPath(root, '.git'))).kind === 'file'
    } catch {
      isWorktree = false
    }
    try {
      await setWorktree($, isWorktree)
    } catch {
      // keep the previous flag
    }
  }
  diagOn = await isDiagOn($)
}

/**
 * Re-reads what the band shows. Never rejects: a failure keeps the old value.
 * `isSlow`: also re-read the project and ask the app for its numbers (the start and every
 * APP_EVERY_TICKS-th tick). That comes after the cheap local reads and before the engine's usage,
 * so a fresh reading is already in place when the engine's figures come to be stored (no flash of
 * the engine's context figure at start). The fast tick reads only the engine's usage and the
 * clock; "now" (which lets the band draw at all) is set last.
 */
async function refresh($: EngineInterface, settings: Settings, isSlow: boolean): Promise<void> {
  if (isSlow) {
    await refreshProject($)
    await refreshAppUsage($)
  }
  try {
    const usage = await $.session.usage()
    await storeEngineUsage($, usage.context.percent, usage.rateLimits)
  } catch {
    // keep the previous usage
  }

  try {
    await setNow($, await $.clock.now())
  } catch {
    // keep the previous time
  }
  await writeDiag($, settings)
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    // The first measurement after a start (a resume, a restart of the app, a hot reload)
    // names every unit and is not activity: forget that one was seen. Before next(e), so
    // a measurement raised while the start runs still counts as the first one.
    try {
      await setMeasureSeen($, false)
    } catch {
      // keep the previous flag
    }
    // No turn runs at a start: a flag left over from a killed window must not keep the
    // "turn running" note for ever (turn.start sets it again for a real running turn).
    try {
      await setTurnRunning($, false)
    } catch {
      // keep the previous flag
    }
    // Nothing waits or runs at a start (a compact that finished or was killed leaves no state).
    try {
      await setCompactState($, 'idle')
    } catch {
      // keep the previous state
    }
    // A reload keeps $.state: an earlier version stored the raw git remote there.
    await sanitizeStoredRemote($)
    const result = await next(e)
    // A hot reload cancels old timers and runs session.start again: no timer bookkeeping.
    resetAppBookkeeping()
    $.clock.every(REFRESH_MS, () => {
      tickCount += 1
      void refresh($, settings, tickCount % APP_EVERY_TICKS === 0)
      void releaseCompactHold($)
      void maybeStartGuard($, settings)
    })
    // The first refresh does the slow reads at once; the ticks then do them on the 4th, 8th, ...
    void refresh($, settings, true)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      await storeEngineUsage($, e.context.percent, e.rateLimits)
    } catch {
      // keep the previous usage
    }
    // Diagnostic only: count every measurement that arrives, the first one too, and keep what the
    // last one carried. Own try, before the logic below, so a failure here can never change what
    // that logic does.
    try {
      const seen = await read($, measureSeenAtom)
      await bumpMeasureCount($)
      await setMeasureInfo($, { atMs: await $.clock.now(), changed: [...e.changed], seen })
    } catch {
      // diagnostics are best effort
    }
    // Cache countdown: the model is called on every tool call of a long turn, and each call
    // renews the cache TTL, but turn.complete comes only at the end. A measurement is raised
    // when cost or context moved, i.e. after a model response: that is the activity time.
    // The first measurement after a start names every unit it has a figure for (it is not
    // a response), so it only marks the flag; otherwise a resumed window would look warm.
    try {
      if (!(await read($, measureSeenAtom))) {
        await setMeasureSeen($, true)
      } else if (e.changed.includes('cost') || e.changed.includes('context')) {
        const now = await $.clock.now()
        await setLast($, now)
        await setNow($, now)
      }
    } catch {
      // keep the previous activity time
    }
    return result
  })

  // The prompt: observe only. The hook does its bookkeeping inside try/catch and always passes the
  // prompt on unchanged, so it can never block or alter one. A prompt of the person's own re-arms
  // the safeguard and, while a flush turn runs or waits, cancels the compact that would follow it.
  on('prompt.submit', async (_$, e, next) => {
    try {
      notePrompt(e.origin, e.isMeta === true)
    } catch {
      // bookkeeping is best effort
    }
    return next(e)
  })

  // The "turn running" note on the cache segment, and the activity time: the prompt of a turn is a
  // model request, which renews the cache, so the countdown starts over here (the responses of the
  // turn move it on through session.measure). Observe-only: the flag is set after the chain below
  // has answered, and a failure here never reaches the turn. The engine pairs each turn.start with
  // a turn.complete (an interrupted turn's too), which clears the flag.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        const now = await $.clock.now()
        await setTurnRunning($, true)
        await setLast($, now)
        await setNow($, now)
      } catch {
        // keep the previous flag
      }
      // The first main-loop turn after the safeguard sent its flush text, carrying exactly that
      // text, is its flush turn; its end starts the compact. (A person coming back is handled in
      // the prompt.submit hook; a turn with other words changes nothing here.)
      const isFlushTurn =
        guardPhase === 'flushing' &&
        guardTurnId === null &&
        e.text.trim().toLowerCase() === settings.flushText.trim().toLowerCase()
      if (isFlushTurn) {
        guardTurnId = e.turnId
        guardLastResult = 'flush turn running'
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Diagnostic only: every completed turn, a subagent's too, to set against the measurement
    // count. Own try: a failure never reaches the logic below.
    try {
      await bumpTurnCount($)
    } catch {
      // diagnostics are best effort
    }
    if (e.agentId === undefined) {
      try {
        const now = await $.clock.now()
        await setLast($, now)
        await setNow($, now)
      } catch {
        // keep the previous activity time
      }
      try {
        await setTurnRunning($, false)
      } catch {
        // keep the previous flag
      }
      try {
        const usage = await $.session.usage()
        await storeEngineUsage($, usage.context.percent, usage.rateLimits)
      } catch {
        // keep the previous usage
      }
      // Not awaited: a slow app call must never hold up the end of a turn.
      void refreshAppUsage($)
      // Not awaited either: the compact is queued behind this very turn's end.
      void continueGuard($, e.turnId, e.reason)
    }
    return result
  })

  // A compaction of the main conversation, whoever starts it (the button, the safeguard, the
  // person's own `/compact`, the engine at its threshold): the band shows "compacting" for as long
  // as it runs and a short while after (the context figure lags behind). Pass-through: the result
  // of next(e) is returned as it came, and a failure of the bookkeeping never reaches the compact.
  // A `precompute` (nothing is installed) and a subagent's own compaction are not shown.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    let isCounted = false
    try {
      compactInFlight += 1
      isCounted = true
      compactReleaseMs = (await $.clock.now()) + COMPACT_FALLBACK_MS
      await setCompactState($, 'running')
    } catch {
      // keep the band as it was
    }
    try {
      return await next(e)
    } finally {
      if (isCounted) {
        try {
          compactInFlight = Math.max(0, compactInFlight - 1)
          if (compactInFlight === 0) compactReleaseMs = (await $.clock.now()) + COMPACT_SETTLE_MS
        } catch {
          // the fallback releases the hold
        }
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const input = await loadInput($, settings)
    const segments = buildSegments(input)
    if (segments.length === 0) return next(e)
    renderCount += 1
    lastRenderMs = input.nowMs

    const { Box, Text, Link, Button } = $.ui.resolve(e)
    // Props are set only when they carry a value: a plain-data tree has no undefined.
    const drawSegment = (s: Segment) => {
      if (s.href !== undefined) return <Link key={s.key} href={s.href} label={s.text} />
      if (s.tone !== undefined) {
        return (
          <Text key={s.key} color={s.tone}>
            {s.text}
          </Text>
        )
      }
      if (s.isDim === true) {
        return (
          <Text key={s.key} dimColor>
            {s.text}
          </Text>
        )
      }
      return <Text key={s.key}>{s.text}</Text>
    }

    // A button is its own element beside the text, not inside it, and stays last. No separator
    // belongs to it: on a narrow band it wraps to a row of its own and a bar left behind would
    // stand alone; the arrow in its text marks it.
    const drawButton = (s: Segment) => (
      <Button
        key={s.key}
        plain
        onPress={() => {
          void requestCompact($)
        }}
      >
        {s.tone !== undefined ? <Text color={s.tone}>{s.text}</Text> : <Text>{s.text}</Text>}
      </Button>
    )

    const textSegments = segments.filter((s) => s.action === undefined)
    const buttonSegments = segments.filter((s) => s.action !== undefined)
    const parts = textSegments.flatMap((s, i) =>
      i === 0
        ? [drawSegment(s)]
        : [
            <Text key={`sep-${s.key}`} dimColor>
              {' │ '}
            </Text>,
            drawSegment(s),
          ],
    )
    const buttons = buttonSegments.map((s) => drawButton(s))
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text wrap="truncate-end">{parts}</Text>
        {buttons}
      </Box>
    )
  })
}
