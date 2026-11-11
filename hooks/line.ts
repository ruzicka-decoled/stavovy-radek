// Pure logic of the status line: options, thresholds, arrow, countdowns, parsing, URLs.
//
// No `$`, no engine globals, no Date: the hooks module (register.tsx) and the
// tests (line.test.ts) both import from here. Time always comes in as epoch
// milliseconds (the hooks read it from `$.clock.now()`).

export type Tone = 'success' | 'warning' | 'error'

/** One piece of the line, before it is turned into elements. */
export type Segment = {
  key: string
  text: string
  /** Theme colour key; absent draws in the default colour. */
  tone?: Tone
  isDim?: boolean
  /** When set, the text is drawn as a link to this https URL. */
  href?: string
  /**
   * When set, the segment is a button, not text: `compact` runs the command `/compact` when
   * pressed. The band draws it last, after the text segments.
   */
  action?: 'compact'
}

/**
 * Where a press of the compact hint stands: `idle` (nothing pressed, the hint is a button) or
 * `running` (a compact was started; the hint is plain text for a while so a second press cannot
 * queue a second compact).
 */
export type CompactState = 'idle' | 'running'

export type LineRateLimit = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

/** Everything the line is drawn from (the values kept in `$.state`). */
export type LineInput = {
  model: string | null
  contextPercent: number | null
  /** The size of the window the context percent is counted against (tokens), or null/absent when unknown. */
  contextWindow?: number | null
  rateLimits: readonly LineRateLimit[]
  lastActivityMs: number | null
  nowMs: number | null
  root: string | null
  /** The GitHub URL of the repository (`githubUrl` of its remote), or null; never a raw remote. */
  remote: string | null
  isWorktree: boolean
  /**
   * True from `turn.start` to `turn.complete` of the main loop. The cache segment then gets a
   * "turn running" note; the countdown itself still runs from the last activity. Absent counts
   * as false.
   */
  isTurnRunning?: boolean
  /** Where a press of the compact hint stands; absent counts as `idle`. */
  compactState?: CompactState
  /** The mod's options; absent counts as the defaults. */
  settings?: Settings
}

/**
 * Limits and context as the desktop app reports them (the numbers its limits
 * card and its composer show), parsed from the `get_usage` reply.
 */
export type AppUsage = {
  windows: LineRateLimit[]
  /** 0 to 100, the figure auto-compact is counted against; null when not reported. */
  contextPercent: number | null
  /** Tokens, the size of the window the percent is counted against; null when not reported. */
  contextWindow: number | null
}

export const MINUTE_MS = 60 * 1000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
export const FIVE_HOURS_MS = 5 * HOUR_MS
export const SEVEN_DAYS_MS = 7 * DAY_MS
/** A reading from the app is trusted over the engine's for this long. */
export const APP_FRESH_MS = 5 * MINUTE_MS
/** Per-model weekly windows are kept under `seven_day:<Name>`. */
export const MODEL_KIND_PREFIX = 'seven_day:'

// ---------------------------------------------------------------------------------------------
// Options (the manifest's `userConfig`), parsed once by `readSettings`.
// ---------------------------------------------------------------------------------------------

/** What the safeguard does when the cache is about to run out in an idle window. */
export type GuardMode = 'off' | 'compact' | 'flush-then-compact'
/** Language of the labels the band draws. */
export type Language = 'cs' | 'en'

export type Settings = {
  /** `off`: the safeguard never acts; `compact`: a real compact; `flush-then-compact`: a flush turn first. */
  guard: GuardMode
  /** The text the `flush-then-compact` mode submits as the person's own message. */
  flushText: string
  /** Prompt cache lifetime in minutes (60 on subscriptions, 5 on API-key sessions). */
  cacheTtlMinutes: number
  language: Language
}

/** Prompt cache lifetime counted from the last activity of the window. */
export const DEFAULT_CACHE_TTL_MINUTES = 60
/** What `flush-then-compact` submits unless the options say otherwise. */
export const DEFAULT_FLUSH_TEXT = 'compact'
export const GUARD_MODES: readonly GuardMode[] = ['off', 'compact', 'flush-then-compact']
export const LANGUAGES: readonly Language[] = ['cs', 'en']
/** The longest cache lifetime accepted (a day); anything above is cut to it. */
export const MAX_CACHE_TTL_MINUTES = 24 * 60
/** A longer flush text is taken for a mistake and replaced by the default. */
export const MAX_FLUSH_TEXT_LENGTH = 500
/** Under this cache lifetime the safeguard never acts: a flush turn would not fit into it. */
export const GUARD_MIN_TTL_MINUTES = 30

export const DEFAULT_SETTINGS: Settings = {
  guard: 'off',
  flushText: DEFAULT_FLUSH_TEXT,
  cacheTtlMinutes: DEFAULT_CACHE_TTL_MINUTES,
  language: 'cs',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The options as `register(on, options)` receives them, turned into typed settings. Anything
 * missing, of the wrong type or outside its range falls back to the default (the safe one: the
 * safeguard stays `off`). Never throws.
 */
export function readSettings(options: unknown): Settings {
  const o: Record<string, unknown> = isRecord(options) ? options : {}

  const guardText = typeof o['guard'] === 'string' ? o['guard'].trim().toLowerCase() : ''
  const guard = GUARD_MODES.find((mode) => mode === guardText) ?? DEFAULT_SETTINGS.guard

  const flushRaw = typeof o['flushText'] === 'string' ? o['flushText'].trim() : ''
  const flushText =
    flushRaw === '' || flushRaw.length > MAX_FLUSH_TEXT_LENGTH ? DEFAULT_FLUSH_TEXT : flushRaw

  const ttlRaw = o['cacheTtlMinutes']
  const ttlNumber =
    typeof ttlRaw === 'number'
      ? ttlRaw
      : typeof ttlRaw === 'string' && ttlRaw.trim() !== ''
        ? Number(ttlRaw)
        : Number.NaN
  const cacheTtlMinutes =
    Number.isFinite(ttlNumber) && ttlNumber > 0
      ? Math.min(MAX_CACHE_TTL_MINUTES, Math.max(1, Math.round(ttlNumber)))
      : DEFAULT_CACHE_TTL_MINUTES

  const languageText = typeof o['language'] === 'string' ? o['language'].trim().toLowerCase() : ''
  const language = LANGUAGES.find((l) => l === languageText) ?? DEFAULT_SETTINGS.language

  return { guard, flushText, cacheTtlMinutes, language }
}

/** The labels of the band that are words (numbers, `ctx`, `5h` and `cache` read the same everywhere). */
export type Labels = {
  /** The weekly limit, all models. */
  week: string
  /** Suffix of a single model's weekly window ("Fable týd."). */
  weekModel: string
  /** Note on the cache segment while a turn runs. */
  turnRunning: string
  /** The cache segment once nothing is left. */
  cacheCold: string
  /** The compact hint after a press. */
  compacting: string
}

const LABELS: Record<Language, Labels> = {
  cs: {
    week: 'týden',
    weekModel: 'týd.',
    turnRunning: 'tah běží',
    cacheCold: 'cache studená',
    compacting: 'compactuji…',
  },
  en: {
    week: 'week',
    weekModel: 'wk',
    turnRunning: 'turn running',
    cacheCold: 'cache cold',
    compacting: 'compacting…',
  },
}

/** The labels of a language; an unknown value reads as Czech. */
export function labelsFor(language: Language): Labels {
  return LABELS[language] ?? LABELS.cs
}

/** The part of the settings the drawing needs. */
export type DisplaySettings = Pick<Settings, 'cacheTtlMinutes' | 'language'>

/**
 * The cache segment is always drawn: green while more than `warn` minutes are left, yellow from
 * `warn` on, red from `red` on. Both scale with the lifetime (25/60 and 10/60 of it, at least one
 * minute): 25 and 10 for the hour of a subscription, 2 and 1 for the 5 minutes of an API key.
 */
export function cacheThresholds(ttlMinutes: number): { warn: number; red: number } {
  return {
    warn: Math.max(1, Math.round((ttlMinutes * 25) / 60)),
    red: Math.max(1, Math.round((ttlMinutes * 10) / 60)),
  }
}

/**
 * What the safeguard really does: `off`, whatever the option says, when the cache lives under 30
 * minutes (a flush turn would not fit into the time that is left).
 */
export function effectiveGuardMode(
  settings: Pick<Settings, 'guard' | 'cacheTtlMinutes'>,
): GuardMode {
  return settings.cacheTtlMinutes < GUARD_MIN_TTL_MINUTES ? 'off' : settings.guard
}

const PERSON_ORIGIN_KINDS: readonly string[] = [
  'composer',
  'bridge',
  'sdk',
  'slack-ping',
  'auto-continuation',
  'unclassified',
]

/**
 * True when a prompt submission is the person's own: their composer, the Remote Control bridge,
 * the app's own host, the owner's Slack ping, a follow-up to their click, or a submission the
 * engine could not attest (`unclassified`). A plugin (this one included), another session, a
 * background notification, a schedule, a channel and any kind not known here are not. A prompt the
 * person does not see as typed (`isMeta`) is never theirs. Pure.
 */
export function isPersonPrompt(origin: unknown, isMeta: boolean = false): boolean {
  if (isMeta || !isRecord(origin)) return false
  const kind = origin['kind']
  return typeof kind === 'string' && PERSON_ORIGIN_KINDS.includes(kind)
}

/**
 * Colour tone of a 0 to 100 percentage: below 50 green, below 80 yellow,
 * from 80 red (49.9 green, 50 yellow, 79.9 yellow, 80 red).
 */
export function toneForPercent(percent: number): Tone {
  if (percent < 50) return 'success'
  if (percent < 80) return 'warning'
  return 'error'
}

/**
 * Whole percent as shown: rounded DOWN, so the digits never contradict the
 * colour (49.9 shows 49 in green, 80 shows 80 in red).
 */
export function wholePercent(percent: number): number {
  return Math.floor(percent)
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** Days from 1970-01-01 to the civil date (proleptic Gregorian). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const shiftedMonth = month > 2 ? month - 3 : month + 9
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)$/

/**
 * Epoch milliseconds of an ISO 8601 date-time with a zone designator
 * (`2026-11-10T12:00:00Z`, `...+02:00`, `...00.500Z`), or null when the text is
 * not one. A date-time WITHOUT a zone is refused: its meaning is a guess.
 * Pure arithmetic, no Date.
 */
export function parseIso(text: string): number | null {
  const m = ISO_PATTERN.exec(text.trim())
  if (m === null) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] === undefined ? 0 : Number(m[6])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const millis = m[7] === undefined ? 0 : Number((m[7] + '00').slice(0, 3))

  let offsetMinutes = 0
  const zone = m[8] ?? 'Z'
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const zoneHours = Number(digits.slice(0, 2))
    const zoneMinutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0
    if (zoneHours > 23 || zoneMinutes > 59) return null
    offsetMinutes = sign * (zoneHours * 60 + zoneMinutes)
  }

  const days = daysFromCivil(year, month, day)
  const utcMs = (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis
  return utcMs - offsetMinutes * MINUTE_MS
}

/**
 * True when consumption runs ahead of the elapsed time of the window:
 * percentUsed > (now - (resetsAt - window)) / window * 100. The window is 5 h
 * unless the caller says otherwise (7 days for the weekly limits). Compared as
 * cross-products so equality is exact (no arrow when they are equal).
 * Elapsed time is not negative; after the reset it exceeds 100 % and no arrow
 * shows.
 */
export function isAhead(
  percentUsed: number,
  resetsAtMs: number,
  nowMs: number,
  windowMs: number = FIVE_HOURS_MS,
): boolean {
  const elapsedMs = Math.max(0, nowMs - (resetsAtMs - windowMs))
  return percentUsed * windowMs > elapsedMs * 100
}

/**
 * "5d 11h" (a day or more) / "2h 13m" / "47m";
 * "reset" once the time has come (or is zero). Under a day the minutes are
 * rounded up, so 30 s left reads "1m" and 23 h 59 m 30 s reads "1d 0h" (the carry goes into the
 * day, never into "24h 0m"). From a day up the hours are
 * rounded DOWN, like the app's own "resets in" text (5d 11h 59m reads 5d 11h).
 */
export function formatReset(resetsAtMs: number, nowMs: number): string {
  const leftMs = resetsAtMs - nowMs
  if (leftMs <= 0) return 'reset'
  if (leftMs >= DAY_MS) {
    const days = Math.floor(leftMs / DAY_MS)
    const hours = Math.floor((leftMs % DAY_MS) / HOUR_MS)
    return `${days}d ${hours}h`
  }
  const minutes = Math.ceil(leftMs / MINUTE_MS)
  if (minutes >= DAY_MS / MINUTE_MS) return '1d 0h'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** True when a reading taken at `lastMs` is younger than `APP_FRESH_MS` at `nowMs`. */
export function isFresh(lastMs: number | null, nowMs: number): boolean {
  return lastMs !== null && nowMs - lastMs < APP_FRESH_MS
}

/** Where the limits and the context currently come from. */
export function usageSource(
  limitsReadMs: number | null,
  contextReadMs: number | null,
  nowMs: number | null,
): 'app' | 'engine' {
  if (nowMs === null) return 'engine'
  return isFresh(limitsReadMs, nowMs) || isFresh(contextReadMs, nowMs) ? 'app' : 'engine'
}

/** Whole minutes of cache life left, rounded up; negative or 0 when cold. */
export function cacheMinutesLeft(
  lastActivityMs: number,
  nowMs: number,
  ttlMinutes: number = DEFAULT_CACHE_TTL_MINUTES,
): number {
  return Math.ceil((ttlMinutes * MINUTE_MS - (nowMs - lastActivityMs)) / MINUTE_MS)
}

/**
 * The prompt cache segment, always drawn. The countdown runs from the last recorded activity
 * whether a turn runs or not; a running turn only adds the note "· tah běží" (every model response
 * of the turn is recorded as activity, so a turn that waits for hours on a question to the person
 * counts down like an idle window):
 *  - last activity unknown (a window the mod met mid-idle): dim "cache –";
 *  - otherwise the minutes left, rounded up: green above the warn threshold, yellow from it down,
 *    red from the red threshold down (25 and 10 of 60 minutes, scaled to the lifetime), and red
 *    "cache studená" when none is left.
 */
export function cacheSegment(
  lastActivityMs: number | null,
  nowMs: number,
  isTurnRunning: boolean = false,
  settings: DisplaySettings = DEFAULT_SETTINGS,
): Segment {
  const labels = labelsFor(settings.language)
  const suffix = isTurnRunning ? ` · ${labels.turnRunning}` : ''
  if (lastActivityMs === null) return { key: 'cache', text: `cache –${suffix}`, isDim: true }
  const ttlMinutes = settings.cacheTtlMinutes
  // A clock that runs behind the stored time must not promise more than one lifetime.
  const left = Math.min(ttlMinutes, cacheMinutesLeft(lastActivityMs, nowMs, ttlMinutes))
  if (left <= 0) return { key: 'cache', text: `${labels.cacheCold}${suffix}`, tone: 'error' }
  const { warn, red } = cacheThresholds(ttlMinutes)
  const tone: Tone = left <= red ? 'error' : left <= warn ? 'warning' : 'success'
  return { key: 'cache', text: `cache ${left} min${suffix}`, tone }
}

/** The compact hint appears from this context fill (percent as the app counts it) ... */
export const COMPACT_CONTEXT_PERCENT = 50

/**
 * The hint "→ /compact", last on the line, or null when no compact is due:
 *  - the context is filled to 50 % or more (yellow, red from 80 like the context itself):
 *    the app auto-compacts at 92 %, and a compact started by hand leaves room for the flush;
 *  - no turn runs and the cache has its red-threshold minutes or fewer left (or is cold; 10 of 60),
 *    whatever the context fill (as long as it is known): a compact now makes the next, cold-cache
 *    turn cheap.
 * The segment is a button (`action: 'compact'`): a press runs the real `/compact` through
 * `$.command.run` (the bare word in the chat, `$.session.compact` and `$.prompt.submit('/compact')`
 * are refused by the desktop app). The only compact the mod starts without a press is the
 * safeguard below, when it is switched on.
 * Once pressed, the segment is plain text ("compactuji…") whatever the thresholds say.
 */
export function compactSegment(
  contextPercent: number | null,
  lastActivityMs: number | null,
  nowMs: number,
  isTurnRunning: boolean = false,
  compactState: CompactState = 'idle',
  settings: DisplaySettings = DEFAULT_SETTINGS,
): Segment | null {
  if (compactState === 'running') {
    return { key: 'compact', text: labelsFor(settings.language).compacting, tone: 'warning' }
  }
  if (contextPercent === null || !Number.isFinite(contextPercent)) return null
  const text = '→ /compact'
  if (contextPercent >= COMPACT_CONTEXT_PERCENT) {
    return {
      key: 'compact',
      text,
      tone: toneForPercent(contextPercent) === 'error' ? 'error' : 'warning',
      action: 'compact',
    }
  }
  if (
    !isTurnRunning &&
    lastActivityMs !== null &&
    cacheMinutesLeft(lastActivityMs, nowMs, settings.cacheTtlMinutes) <=
      cacheThresholds(settings.cacheTtlMinutes).red
  ) {
    return { key: 'compact', text, tone: 'warning', action: 'compact' }
  }
  return null
}

// The safeguard (off by default). A window left alone until the prompt cache is about to run out
// is compacted by the mod, so the first turn after the break reads a small context instead of the
// whole one from a cold cache. The decision is pure (`isGuardDue`); register.tsx does the steps,
// by mode: `compact` runs the real `/compact`; `flush-then-compact` first submits the flush text
// as the person's own message and runs `/compact` after that turn.

/** ... but not with fewer than this many minutes left: a flush started after the expiry would renew nothing. */
export const GUARD_MIN_MINUTES_LEFT = 2

/**
 * True when the safeguard should start now: no turn runs, the cache lives at least
 * GUARD_MIN_TTL_MINUTES, the context fill is known (any fill counts), and the cache has between
 * GUARD_MIN_MINUTES_LEFT and its red-threshold minutes left (10 of 60). A window whose last
 * activity is unknown never qualifies (it was met mid-idle). The mode is not judged here
 * (`effectiveGuardMode`).
 */
export function isGuardDue(
  contextPercent: number | null,
  lastActivityMs: number | null,
  nowMs: number,
  isTurnRunning: boolean = false,
  settings: Pick<Settings, 'cacheTtlMinutes'> = DEFAULT_SETTINGS,
): boolean {
  if (isTurnRunning || settings.cacheTtlMinutes < GUARD_MIN_TTL_MINUTES) return false
  if (contextPercent === null || !Number.isFinite(contextPercent)) return false
  if (lastActivityMs === null) return false
  const left = cacheMinutesLeft(lastActivityMs, nowMs, settings.cacheTtlMinutes)
  return left <= cacheThresholds(settings.cacheTtlMinutes).red && left >= GUARD_MIN_MINUTES_LEFT
}

/**
 * The model id as the band shows it: without the leading "claude-" that every id
 * carries ("sonnet-5-5"). An id that is only "claude-" or
 * does not start with it stays as it is.
 */
export function shortModelName(model: string): string {
  const short = model.replace(/^claude-/i, '')
  return short === '' ? model : short
}

/**
 * A token count for the band: under 1000 the whole number, thousands as "k" (1500 is "2k"),
 * millions as "M" with one decimal only when needed ("1M", "1.5M"). Null for anything that is
 * not a positive finite number.
 */
export function formatTokens(tokens: number): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 999500) return `${Math.round(tokens / 1000)}k`
  const millions = Math.round((tokens / 1000000) * 10) / 10
  return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
}

/**
 * Context segment: "ctx 81 % / 400k" (percent and the size of the window it is counted against);
 * without a known size "ctx 81 %"; "ctx –" (dim) while the fill is not known yet.
 */
export function contextSegment(percent: number | null, windowTokens: number | null = null): Segment {
  if (percent === null || !Number.isFinite(percent)) {
    return { key: 'context', text: 'ctx –', isDim: true }
  }
  const size = windowTokens === null ? null : formatTokens(windowTokens)
  return {
    key: 'context',
    text: `ctx ${wholePercent(percent)} %${size === null ? '' : ` / ${size}`}`,
    tone: toneForPercent(percent),
  }
}

/** How one kind of limit window is drawn. */
type LimitStyle = {
  key: string
  label: string
  windowMs: number
  /** Whether " · 5d 11h" follows; the per-model windows leave it out to keep the band short. */
  showReset: boolean
  /** Shown only when something is used (the per-model windows). */
  hideWhenZero: boolean
}

/** The look of a window kind; null for kinds the line does not show (`spend_limit`, unknown). */
function styleOfKind(kind: string, labels: Labels): LimitStyle | null {
  if (kind === 'five_hour') {
    return { key: 'limit', label: '5h', windowMs: FIVE_HOURS_MS, showReset: true, hideWhenZero: false }
  }
  if (kind === 'seven_day') {
    return {
      key: 'limit-week',
      label: labels.week,
      windowMs: SEVEN_DAYS_MS,
      showReset: true,
      hideWhenZero: false,
    }
  }
  if (kind.startsWith(MODEL_KIND_PREFIX)) {
    const name = kind.slice(MODEL_KIND_PREFIX.length)
    if (name === '') return null
    return {
      key: `limit-model-${name}`,
      label: `${name} ${labels.weekModel}`,
      windowMs: SEVEN_DAYS_MS,
      showReset: false,
      hideWhenZero: true,
    }
  }
  return null
}

/**
 * One limit window as a segment: "5h 41 %" + "↑" right after the percent when
 * consumption outruns the elapsed window + " · 2h 13m". Null for a
 * kind the line does not show, a percent that is not a number, or a per-model
 * window with nothing used.
 */
function limitSegment(limit: LineRateLimit, nowMs: number, labels: Labels): Segment | null {
  const style = styleOfKind(limit.kind, labels)
  if (style === null) return null
  if (!Number.isFinite(limit.percentUsed)) return null
  if (style.hideWhenZero && !(limit.percentUsed > 0)) return null
  let text = `${style.label} ${wholePercent(limit.percentUsed)} %`
  const resetsAtMs = limit.resetsAt === null ? null : parseIso(limit.resetsAt)
  if (resetsAtMs !== null) {
    if (isAhead(limit.percentUsed, resetsAtMs, nowMs, style.windowMs)) text += '↑'
    if (style.showReset) text += ` · ${formatReset(resetsAtMs, nowMs)}`
  }
  return { key: style.key, text, tone: toneForPercent(limit.percentUsed) }
}

/**
 * The limit segments, left to right: 5 h, weekly (all models), then the
 * weekly windows of single models that have something used. A window the
 * account does not report has no segment; of two windows of one kind the
 * first counts.
 */
export function limitSegments(
  limits: readonly LineRateLimit[],
  nowMs: number,
  settings: Pick<Settings, 'language'> = DEFAULT_SETTINGS,
): Segment[] {
  const labels = labelsFor(settings.language)
  const rank = (kind: string): number => (kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : 2)
  const ordered = limits
    .map((limit, index) => ({ limit, index }))
    .sort((a, b) => rank(a.limit.kind) - rank(b.limit.kind) || a.index - b.index)
  const segments: Segment[] = []
  for (const { limit } of ordered) {
    const segment = limitSegment(limit, nowMs, labels)
    if (segment === null) continue
    if (segments.some((s) => s.key === segment.key)) continue
    segments.push(segment)
  }
  return segments
}

/**
 * The 5 h limit segment alone ("5h 41 %↑ · 2h 13m"); null when the
 * account reports no `five_hour` window (a plan without limits).
 */
export function fiveHourSegment(
  limits: readonly LineRateLimit[],
  nowMs: number,
): Segment | null {
  return limitSegments(limits, nowMs).find((s) => s.key === 'limit') ?? null
}

/**
 * The kind a window of the app's limits card belongs to, from its label
 * (case-insensitive): "Weekly · all models" is `seven_day`, "Weekly · Fable"
 * is `seven_day:Fable`, "7-day" / "7 days" is a weekly window too, a 5-hour / "five" /
 * "session" label is `five_hour`. Null for any other label.
 */
export function kindOfAppLabel(label: string): string | null {
  if (/week|7[\s-]?days?\b/i.test(label)) {
    const rest = label
      .replace(/\b(?:weekly|weeks?|7[\s-]?days?)\b/i, ' ')
      .replace(/^[\s·•|:\-–—]+|[\s·•|:\-–—]+$/g, '')
      .trim()
    if (rest === '' || /^all\b/i.test(rest)) return 'seven_day'
    return `${MODEL_KIND_PREFIX}${rest}`
  }
  if (/(?:^|[^0-9])5\s*-?\s*(?:h|hour)/i.test(label) || /five/i.test(label) || /session/i.test(label)) {
    return 'five_hour'
  }
  return null
}

/**
 * Parses the JSON text of the app's `get_usage` reply. Defensive: any broken
 * piece (not JSON, a status other than "ok", a window without a label or a
 * numeric percent, an unknown label) is skipped and the rest still counts.
 * `resetsAt` is kept as the ISO text when `parseIso` accepts it, else null.
 */
export function parseAppUsage(text: string): AppUsage {
  const result: AppUsage = { windows: [], contextPercent: null, contextWindow: null }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return result
  }
  if (!isRecord(data)) return result

  const plan = data['plan']
  if (isRecord(plan) && plan['status'] === 'ok' && Array.isArray(plan['windows'])) {
    for (const entry of plan['windows'] as unknown[]) {
      if (!isRecord(entry)) continue
      const label = entry['label']
      const percentUsed = entry['percentUsed']
      if (typeof label !== 'string') continue
      if (typeof percentUsed !== 'number' || !Number.isFinite(percentUsed) || percentUsed < 0) continue
      const kind = kindOfAppLabel(label)
      if (kind === null) continue
      if (result.windows.some((w) => w.kind === kind)) continue
      const resetsAt = entry['resetsAt']
      result.windows.push({
        kind,
        percentUsed,
        resetsAt: typeof resetsAt === 'string' && parseIso(resetsAt) !== null ? resetsAt : null,
      })
    }
  }

  const context = data['context']
  if (isRecord(context) && context['status'] === 'ok') {
    const percent = context['percentUsed']
    if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0) {
      result.contextPercent = Math.min(100, percent)
    }
    const size = context['contextWindow']
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) result.contextWindow = size
  }
  return result
}

/** The text of the first `text` block of an MCP result, or null. */
export function firstTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content as unknown[]) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      return block['text']
    }
  }
  return null
}

/** At most `limit` characters of an error's message, for the diagnostic file. */
export function errorText(error: unknown, limit: number = 120): string {
  let message = 'error'
  if (typeof error === 'string') message = error
  else if (isRecord(error) && typeof error['message'] === 'string') message = error['message']
  return message === '' ? 'error' : message.slice(0, limit)
}

/**
 * `https://github.com/o/r` for a GitHub remote in either form
 * (`https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`); null for
 * anything else. A remote carrying credentials never matches.
 */
export function githubUrl(remote: string | null): string | null {
  if (remote === null) return null
  const text = remote.trim()
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text) ??
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text)
  if (match === null) return null
  return `https://github.com/${match[1]}/${match[2]}`
}

/** Last path component; separators `/` and `\`, trailing ones ignored. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(cut + 1)
}

/** Joins a directory and a name with one `/`, whatever ended the directory. */
export function joinPath(directory: string, name: string): string {
  return directory.replace(/[\\/]+$/, '') + '/' + name
}

/**
 * Turns the kept values into the segments of the line, left to right:
 * model, context, cache, 5 h limit, weekly limit, per-model weekly limits,
 * project, worktree, compact hint.
 *
 * Scratch folder (the session's scratch directory): unavailable in this
 * build's API, so there is no segment for it.
 *
 * Empty until the first refresh has happened (`nowMs` null): there is nothing
 * true to show yet and the hook then lets the engine draw the band.
 */
export function buildSegments(input: LineInput): Segment[] {
  const nowMs = input.nowMs
  if (nowMs === null) return []
  const settings = input.settings ?? DEFAULT_SETTINGS
  const segments: Segment[] = []

  if (input.model !== null && input.model !== '') {
    segments.push({ key: 'model', text: shortModelName(input.model), isDim: true })
  }
  segments.push(contextSegment(input.contextPercent, input.contextWindow ?? null))

  segments.push(cacheSegment(input.lastActivityMs, nowMs, input.isTurnRunning === true, settings))

  segments.push(...limitSegments(input.rateLimits, nowMs, settings))

  if (input.root !== null && input.root !== '') {
    const name = baseName(input.root)
    if (name !== '') {
      const href = githubUrl(input.remote)
      segments.push(href === null ? { key: 'project', text: name } : { key: 'project', text: name, href })
      if (input.isWorktree) segments.push({ key: 'worktree', text: `wt ${name}` })
    }
  }

  // scratch: unavailable in this build's API (no scratch/tmp/session-dir call).

  const compact = compactSegment(
    input.contextPercent,
    input.lastActivityMs,
    nowMs,
    input.isTurnRunning === true,
    input.compactState ?? 'idle',
    settings,
  )
  if (compact !== null) segments.push(compact)
  return segments
}
