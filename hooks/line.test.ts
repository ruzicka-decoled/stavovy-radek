import { describe, expect, test } from 'claude-code/testing'
import {
  APP_FRESH_MS,
  DAY_MS,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_FLUSH_TEXT,
  DEFAULT_SETTINGS,
  HOUR_MS,
  MINUTE_MS,
  SEVEN_DAYS_MS,
  baseName,
  buildSegments,
  cacheSegment,
  cacheThresholds,
  compactSegment,
  contextSegment,
  effectiveGuardMode,
  errorText,
  fiveHourSegment,
  firstTextBlock,
  formatReset,
  githubUrl,
  isAhead,
  isFresh,
  isGuardDue,
  isPersonPrompt,
  joinPath,
  kindOfAppLabel,
  labelsFor,
  limitSegments,
  parseAppUsage,
  parseIso,
  readSettings,
  shortModelName,
  toneForPercent,
  usageSource,
  wholePercent,
} from './line'
import type { LineInput } from './line'

// 2026-11-10T00:00:00Z, checked against an independent calendar computation.
const MIDNIGHT = 1794268800000
const NOW = MIDNIGHT + 12 * HOUR_MS

/** A cache whose last activity leaves exactly this many milliseconds of life. */
function lastWithLeftMs(leftMs: number): number {
  return NOW - (DEFAULT_CACHE_TTL_MINUTES * MINUTE_MS - leftMs)
}
function lastWithLeftMinutes(minutes: number): number {
  return lastWithLeftMs(minutes * MINUTE_MS)
}

describe('shortModelName', () => {
  test('drops the leading "claude-" and nothing else', () => {
    expect(shortModelName('claude-sonnet-5-5')).toBe('sonnet-5-5')
    expect(shortModelName('claude-opus-5-5')).toBe('opus-5-5')
    expect(shortModelName('Claude-Haiku-5-5')).toBe('Haiku-5-5')
    expect(shortModelName('my-claude-model')).toBe('my-claude-model')
    expect(shortModelName('gpt-test')).toBe('gpt-test')
  })

  test('an id that is only the prefix stays as it is', () => {
    expect(shortModelName('claude-')).toBe('claude-')
  })
})

describe('toneForPercent', () => {
  test('boundaries: 49.9 green, 50 yellow, 79.9 yellow, 80 red', () => {
    expect(toneForPercent(0)).toBe('success')
    expect(toneForPercent(49.9)).toBe('success')
    expect(toneForPercent(50)).toBe('warning')
    expect(toneForPercent(79.9)).toBe('warning')
    expect(toneForPercent(80)).toBe('error')
    expect(toneForPercent(100)).toBe('error')
  })

  test('shown digits never contradict the colour (rounded down)', () => {
    expect(wholePercent(49.9)).toBe(49)
    expect(wholePercent(50)).toBe(50)
    expect(wholePercent(79.9)).toBe(79)
    expect(wholePercent(80)).toBe(80)
  })
})

describe('parseIso', () => {
  test('known instants', () => {
    expect(parseIso('1970-01-01T00:00:00Z')).toBe(0)
    expect(parseIso('2000-01-01T00:00:00Z')).toBe(946684800000)
    expect(parseIso('2026-11-10T00:00:00Z')).toBe(MIDNIGHT)
    expect(parseIso('2024-02-29T12:00:00Z')).toBe(1709208000000)
    expect(parseIso('1969-12-31T23:59:59Z')).toBe(-1000)
  })

  test('zone offsets move the instant', () => {
    expect(parseIso('2026-11-10T14:00:00+02:00')).toBe(NOW)
    expect(parseIso('2026-11-10T07:30:00-0430')).toBe(NOW)
    expect(parseIso('2026-11-10T14:00:00+02')).toBe(NOW)
  })

  test('fraction of a second and missing seconds', () => {
    expect(parseIso('2026-11-10T00:00:00.500Z')).toBe(MIDNIGHT + 500)
    expect(parseIso('2026-11-10T00:00:00.5Z')).toBe(MIDNIGHT + 500)
    expect(parseIso('2026-11-10T00:00:00.123456Z')).toBe(MIDNIGHT + 123)
    expect(parseIso('2026-11-10T12:00Z')).toBe(NOW)
  })

  test('not an ISO date-time with a zone gives null', () => {
    expect(parseIso('')).toBeNull()
    expect(parseIso('soon')).toBeNull()
    expect(parseIso('2026-13-01T00:00:00Z')).toBeNull()
    expect(parseIso('2026-02-30T00:00:00Z')).toBeNull()
    expect(parseIso('2025-02-29T00:00:00Z')).toBeNull()
    expect(parseIso('2026-11-10T24:00:00Z')).toBeNull()
    expect(parseIso('2026-11-10T12:60:00Z')).toBeNull()
    expect(parseIso('2026-11-10T12:00:00')).toBeNull()
  })
})

describe('isAhead (arrow after the 5 h percent)', () => {
  // The window ends in 3 h, so 2 h of 5 h (exactly 40 %) have passed.
  const resetsAt = NOW + 3 * HOUR_MS

  test('consumption below the elapsed time: no arrow', () => {
    expect(isAhead(39, resetsAt, NOW)).toBe(false)
    expect(isAhead(10, resetsAt, NOW)).toBe(false)
  })

  test('consumption above the elapsed time: arrow', () => {
    expect(isAhead(41, resetsAt, NOW)).toBe(true)
    expect(isAhead(40.1, resetsAt, NOW)).toBe(true)
  })

  test('equality is no arrow', () => {
    expect(isAhead(40, resetsAt, NOW)).toBe(false)
  })

  test('window just after a reset: elapsed 0 %', () => {
    const start = resetsAtOf(NOW)
    expect(isAhead(0, start, NOW)).toBe(false)
    expect(isAhead(1, start, NOW)).toBe(true)
    // one minute in is 0.33 % of the window
    expect(isAhead(0.1, start, NOW + MINUTE_MS)).toBe(false)
    expect(isAhead(0.5, start, NOW + MINUTE_MS)).toBe(true)
  })

  test('clock slightly before the window start counts as elapsed 0', () => {
    const start = resetsAtOf(NOW)
    expect(isAhead(0, start, NOW - MINUTE_MS)).toBe(false)
    expect(isAhead(2, start, NOW - MINUTE_MS)).toBe(true)
  })

  test('after the reset the old window shows no arrow', () => {
    expect(isAhead(100, NOW - MINUTE_MS, NOW)).toBe(false)
  })
})

/** The reset time of a window that starts exactly at `windowStartMs`. */
function resetsAtOf(windowStartMs: number): number {
  return windowStartMs + 5 * HOUR_MS
}

describe('formatReset', () => {
  test('under an hour: minutes only', () => {
    expect(formatReset(NOW + 47 * MINUTE_MS, NOW)).toBe('47m')
    expect(formatReset(NOW + MINUTE_MS, NOW)).toBe('1m')
  })

  test('hours and minutes', () => {
    expect(formatReset(NOW + 2 * HOUR_MS + 13 * MINUTE_MS, NOW)).toBe('2h 13m')
    expect(formatReset(NOW + HOUR_MS, NOW)).toBe('1h 0m')
  })

  test('minutes are rounded up', () => {
    expect(formatReset(NOW + 30 * 1000, NOW)).toBe('1m')
    expect(formatReset(NOW + 59 * MINUTE_MS + 30 * 1000, NOW)).toBe('1h 0m')
  })

  test('at or after the reset: just "reset"', () => {
    expect(formatReset(NOW, NOW)).toBe('reset')
    expect(formatReset(NOW - 5 * MINUTE_MS, NOW)).toBe('reset')
  })

  test('a day or more: days and hours, hours rounded down like the app', () => {
    expect(formatReset(NOW + DAY_MS, NOW)).toBe('1d 0h')
    expect(formatReset(NOW + 5 * DAY_MS + 11 * HOUR_MS, NOW)).toBe('5d 11h')
    // 2026-11-15T23:59:59.722Z seen from 2026-11-10T12:00:00Z: 5d 11h 59m 59.7s left
    expect(formatReset(parseIso('2026-11-15T23:59:59.722Z') ?? 0, NOW)).toBe('5d 11h')
    expect(formatReset(NOW + 2 * DAY_MS + 59 * MINUTE_MS, NOW)).toBe('2d 0h')
  })

  test('just under a day stays in hours and minutes', () => {
    expect(formatReset(NOW + DAY_MS - 2 * MINUTE_MS, NOW)).toBe('23h 58m')
    expect(formatReset(NOW + DAY_MS - 30 * 1000 - MINUTE_MS, NOW)).toBe('23h 59m')
  })
})

describe('isAhead for the 7 day window (arrow after the weekly percent)', () => {
  // The window ends in 3.5 days, so exactly half of the 7 days (50 %) has passed.
  const resetsAt = NOW + 3.5 * DAY_MS

  test('below the elapsed time: no arrow', () => {
    expect(isAhead(49, resetsAt, NOW, SEVEN_DAYS_MS)).toBe(false)
    expect(isAhead(0, resetsAt, NOW, SEVEN_DAYS_MS)).toBe(false)
  })

  test('above the elapsed time: arrow', () => {
    expect(isAhead(51, resetsAt, NOW, SEVEN_DAYS_MS)).toBe(true)
    expect(isAhead(50.1, resetsAt, NOW, SEVEN_DAYS_MS)).toBe(true)
  })

  test('equality is no arrow', () => {
    expect(isAhead(50, resetsAt, NOW, SEVEN_DAYS_MS)).toBe(false)
  })

  test('the window length matters: the same reset time reads differently for 5 h and 7 days', () => {
    // Ends in 3 h. As a 5 h window 40 % has passed; as a 7 day window 98.2 % (165 h of 168 h).
    const endsInThreeHours = NOW + 3 * HOUR_MS
    expect(isAhead(41, endsInThreeHours, NOW)).toBe(true)
    expect(isAhead(41, endsInThreeHours, NOW, SEVEN_DAYS_MS)).toBe(false)
    expect(isAhead(98, endsInThreeHours, NOW, SEVEN_DAYS_MS)).toBe(false)
    expect(isAhead(99, endsInThreeHours, NOW, SEVEN_DAYS_MS)).toBe(true)
  })

  test('after the reset the old window shows no arrow', () => {
    expect(isAhead(100, NOW - MINUTE_MS, NOW, SEVEN_DAYS_MS)).toBe(false)
  })
})

describe('cacheSegment', () => {
  test('always drawn: 60 minutes left right after the activity, green', () => {
    expect(cacheSegment(lastWithLeftMinutes(60), NOW)).toEqual({
      key: 'cache',
      text: 'cache 60 min',
      tone: 'success',
    })
    expect(cacheSegment(lastWithLeftMinutes(26), NOW)).toEqual({
      key: 'cache',
      text: 'cache 26 min',
      tone: 'success',
    })
  })

  test('25 minutes left: yellow (boundary); 26: still green', () => {
    expect(cacheSegment(lastWithLeftMinutes(25), NOW)).toEqual({
      key: 'cache',
      text: 'cache 25 min',
      tone: 'warning',
    })
    expect(cacheSegment(lastWithLeftMs(25 * MINUTE_MS + 1000), NOW).tone).toBe('success')
    expect(cacheSegment(lastWithLeftMs(24 * MINUTE_MS + 30 * 1000), NOW).text).toBe('cache 25 min')
  })

  test('18 minutes left: yellow', () => {
    expect(cacheSegment(lastWithLeftMinutes(18), NOW)).toEqual({
      key: 'cache',
      text: 'cache 18 min',
      tone: 'warning',
    })
  })

  test('10 minutes or less: red; 11: still yellow', () => {
    expect(cacheSegment(lastWithLeftMinutes(11), NOW).tone).toBe('warning')
    expect(cacheSegment(lastWithLeftMinutes(10), NOW).tone).toBe('error')
    expect(cacheSegment(lastWithLeftMinutes(9), NOW)).toEqual({
      key: 'cache',
      text: 'cache 9 min',
      tone: 'error',
    })
    expect(cacheSegment(lastWithLeftMs(9 * MINUTE_MS + 1000), NOW).text).toBe('cache 10 min')
  })

  test('nothing left: red "cache studená"', () => {
    const cold = { key: 'cache', text: 'cache studená', tone: 'error' }
    expect(cacheSegment(lastWithLeftMinutes(0), NOW)).toEqual(cold)
    expect(cacheSegment(lastWithLeftMinutes(-5), NOW)).toEqual(cold)
  })

  test('unknown last activity: a dim dash, the segment is still there', () => {
    expect(cacheSegment(null, NOW)).toEqual({ key: 'cache', text: 'cache –', isDim: true })
  })

  test('a running turn counts down from the last activity like an idle window and adds a note', () => {
    expect(cacheSegment(lastWithLeftMinutes(60), NOW, true)).toEqual({
      key: 'cache',
      text: 'cache 60 min · tah běží',
      tone: 'success',
    })
    expect(cacheSegment(lastWithLeftMinutes(18), NOW, true)).toEqual({
      key: 'cache',
      text: 'cache 18 min · tah běží',
      tone: 'warning',
    })
    expect(cacheSegment(lastWithLeftMinutes(5), NOW, true)).toEqual({
      key: 'cache',
      text: 'cache 5 min · tah běží',
      tone: 'error',
    })
    expect(cacheSegment(lastWithLeftMinutes(5), NOW, false).text).toBe('cache 5 min')
  })

  test('a turn blocked for hours reads cold, not warm', () => {
    expect(cacheSegment(lastWithLeftMinutes(-90), NOW, true)).toEqual({
      key: 'cache',
      text: 'cache studená · tah běží',
      tone: 'error',
    })
  })

  test('a running turn with an unknown last activity keeps the dim dash and the note', () => {
    expect(cacheSegment(null, NOW, true)).toEqual({
      key: 'cache',
      text: 'cache – · tah běží',
      isDim: true,
    })
  })

  test('a last activity in the future never promises more than one lifetime', () => {
    expect(cacheSegment(NOW + 10 * MINUTE_MS, NOW).text).toBe('cache 60 min')
  })
})

describe('compactSegment', () => {
  test('context 50 % or more: yellow hint, red from 80', () => {
    expect(compactSegment(49.9, null, NOW)).toBeNull()
    expect(compactSegment(50, null, NOW)).toEqual({
      key: 'compact',
      text: '→ /compact',
      tone: 'warning',
      action: 'compact',
    })
    expect(compactSegment(79.9, null, NOW)?.tone).toBe('warning')
    expect(compactSegment(80, null, NOW)?.tone).toBe('error')
    expect(compactSegment(100, null, NOW)?.tone).toBe('error')
  })

  test('49 % with the cache far from its end: no hint; 50 %: hint', () => {
    expect(compactSegment(49, lastWithLeftMinutes(40), NOW)).toBeNull()
    expect(compactSegment(50, lastWithLeftMinutes(40), NOW)?.action).toBe('compact')
  })

  test('cache nearly cold: yellow hint at any known context fill (even 3 %)', () => {
    expect(compactSegment(3, lastWithLeftMinutes(10), NOW)).toEqual({
      key: 'compact',
      text: '→ /compact',
      tone: 'warning',
      action: 'compact',
    })
    expect(compactSegment(3, lastWithLeftMinutes(11), NOW)).toBeNull()
    expect(compactSegment(3, lastWithLeftMinutes(-20), NOW)?.text).toBe('→ /compact')
    expect(compactSegment(0, lastWithLeftMinutes(5), NOW)?.action).toBe('compact')
  })

  test('no hint while a turn runs on the cache rule, but the context rule still holds', () => {
    expect(compactSegment(40, lastWithLeftMinutes(5), NOW, true)).toBeNull()
    expect(compactSegment(75, lastWithLeftMinutes(5), NOW, true)?.tone).toBe('warning')
  })

  test('every hint is a button (action compact), and no other segment is', () => {
    expect(compactSegment(95, null, NOW)?.action).toBe('compact')
    expect(compactSegment(3, lastWithLeftMinutes(5), NOW)?.action).toBe('compact')
    const segments = buildSegments({
      model: 'claude-test-model',
      contextPercent: 85,
      rateLimits: [{ kind: 'seven_day', percentUsed: 23, resetsAt: '2026-11-15T23:59:59Z' }],
      lastActivityMs: lastWithLeftMinutes(18),
      nowMs: NOW,
      root: 'C:/projects/demo',
      remote: 'git@github.com:acme/demo.git',
      isWorktree: true,
    })
    expect(segments.filter((s) => s.action !== undefined).map((s) => s.key)).toEqual(['compact'])
  })

  test('once pressed the segment is plain text, whatever the thresholds say (v0.3.8)', () => {
    const running = compactSegment(10, null, NOW, true, 'running')
    expect(running).toEqual({ key: 'compact', text: 'compactuji…', tone: 'warning' })
    expect(running?.action).toBeUndefined()
    expect(compactSegment(null, null, NOW, false, 'running')?.text).toBe('compactuji…')
    expect(compactSegment(75, null, NOW, false, 'idle')?.action).toBe('compact')
  })

  test('unknown context or unknown last activity: no hint on the rule that needs it', () => {
    expect(compactSegment(null, lastWithLeftMinutes(5), NOW)).toBeNull()
    expect(compactSegment(Number.NaN, null, NOW)).toBeNull()
    expect(compactSegment(49, null, NOW)).toBeNull()
  })

  test('unknown context (null): no hint even when the cache is nearly cold', () => {
    expect(compactSegment(null, lastWithLeftMinutes(5), NOW)).toBeNull()
    expect(compactSegment(null, lastWithLeftMinutes(-20), NOW)).toBeNull()
  })
})

describe('isGuardDue (the safeguard before the cache runs out)', () => {
  test('the defaults: off, and the flush text is "compact"', () => {
    expect(DEFAULT_SETTINGS.guard).toBe('off')
    expect(DEFAULT_FLUSH_TEXT).toBe('compact')
  })

  test('due from 10 minutes of cache left down to 2, at any context fill', () => {
    expect(isGuardDue(40, lastWithLeftMinutes(11), NOW)).toBe(false)
    expect(isGuardDue(40, lastWithLeftMinutes(10), NOW)).toBe(true)
    expect(isGuardDue(40, lastWithLeftMinutes(5), NOW)).toBe(true)
    expect(isGuardDue(40, lastWithLeftMinutes(2), NOW)).toBe(true)
  })

  test('not with less than 2 minutes left or a cold cache: a flush then renews nothing', () => {
    expect(isGuardDue(40, lastWithLeftMinutes(1), NOW)).toBe(false)
    expect(isGuardDue(40, lastWithLeftMinutes(0), NOW)).toBe(false)
    expect(isGuardDue(40, lastWithLeftMinutes(-20), NOW)).toBe(false)
  })

  test('a small context fill (3 %, even 0 %) is due as well', () => {
    expect(isGuardDue(3, lastWithLeftMinutes(5), NOW)).toBe(true)
    expect(isGuardDue(0, lastWithLeftMinutes(5), NOW)).toBe(true)
    expect(isGuardDue(3, lastWithLeftMinutes(11), NOW)).toBe(false)
  })

  test('not while a turn runs', () => {
    expect(isGuardDue(40, lastWithLeftMinutes(5), NOW, true)).toBe(false)
  })

  test('not when the last activity or the context is unknown', () => {
    expect(isGuardDue(40, null, NOW)).toBe(false)
    expect(isGuardDue(null, lastWithLeftMinutes(5), NOW)).toBe(false)
    expect(isGuardDue(Number.NaN, lastWithLeftMinutes(5), NOW)).toBe(false)
  })

  test('not when the clock runs behind the stored time (more than one lifetime "left")', () => {
    expect(isGuardDue(40, NOW + 5 * MINUTE_MS, NOW)).toBe(false)
  })
})

describe('contextSegment', () => {
  test('percent with colour at the boundaries', () => {
    expect(contextSegment(18)).toEqual({ key: 'context', text: 'ctx 18 %', tone: 'success' })
    expect(contextSegment(49.9)).toEqual({ key: 'context', text: 'ctx 49 %', tone: 'success' })
    expect(contextSegment(50)).toEqual({ key: 'context', text: 'ctx 50 %', tone: 'warning' })
    expect(contextSegment(79.9)).toEqual({ key: 'context', text: 'ctx 79 %', tone: 'warning' })
    expect(contextSegment(80)).toEqual({ key: 'context', text: 'ctx 80 %', tone: 'error' })
  })

  test('unknown fill: dim "ctx –"', () => {
    expect(contextSegment(null)).toEqual({ key: 'context', text: 'ctx –', isDim: true })
    expect(contextSegment(Number.NaN)).toEqual({ key: 'context', text: 'ctx –', isDim: true })
  })
})

describe('fiveHourSegment', () => {
  const fiveHour = (percentUsed: number, resetsAt: string | null) => ({
    kind: 'five_hour',
    percentUsed,
    resetsAt,
  })

  test('no five_hour window: no segment', () => {
    expect(fiveHourSegment([], NOW)).toBeNull()
    expect(
      fiveHourSegment([{ kind: 'seven_day', percentUsed: 90, resetsAt: null }], NOW),
    ).toBeNull()
  })

  test('behind the clock: no arrow, with reset countdown', () => {
    // 2 h 13 m left means 2 h 47 m (55.7 %) of the window has passed; 41 % is behind it.
    const resetsAt = NOW + 2 * HOUR_MS + 13 * MINUTE_MS
    expect(fiveHourSegment([fiveHour(41, isoOf(resetsAt))], NOW)).toEqual({
      key: 'limit',
      text: '5h 41 % · 2h 13m',
      tone: 'success',
    })
  })

  test('ahead of the clock: arrow right after the percent', () => {
    const resetsAt = NOW + 3 * HOUR_MS // 40 % of the window has passed
    expect(fiveHourSegment([fiveHour(41, isoOf(resetsAt))], NOW)?.text).toBe(
      '5h 41 %↑ · 3h 0m',
    )
  })

  test('under an hour: minutes only; after the reset just "reset"', () => {
    expect(fiveHourSegment([fiveHour(95, isoOf(NOW + 47 * MINUTE_MS))], NOW)).toEqual({
      key: 'limit',
      text: '5h 95 %↑ · 47m',
      tone: 'error',
    })
    expect(fiveHourSegment([fiveHour(10, isoOf(NOW - MINUTE_MS))], NOW)?.text).toBe(
      '5h 10 % · reset',
    )
  })

  test('colour follows the percent thresholds', () => {
    const at = (p: number) => fiveHourSegment([fiveHour(p, null)], NOW)?.tone
    expect(at(49.9)).toBe('success')
    expect(at(50)).toBe('warning')
    expect(at(79.9)).toBe('warning')
    expect(at(80)).toBe('error')
  })

  test('without a usable reset time only the percent shows', () => {
    expect(fiveHourSegment([fiveHour(41, null)], NOW)?.text).toBe('5h 41 %')
    expect(fiveHourSegment([fiveHour(41, 'garbage')], NOW)?.text).toBe('5h 41 %')
  })

  test('picks the five_hour window among others', () => {
    const limits = [
      { kind: 'seven_day', percentUsed: 90, resetsAt: null },
      fiveHour(10, null),
    ]
    expect(fiveHourSegment(limits, NOW)?.text).toBe('5h 10 %')
  })
})

/** ISO text of an epoch time, built by hand (no Date); only for whole-second UTC. */
function isoOf(epochMs: number): string {
  const totalSeconds = Math.floor(epochMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const rest = totalSeconds - days * 86400
  // civil date from days since 1970-01-01 (inverse of the algorithm under test)
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const dayOfEra = z - era * 146097
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  )
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const monthShifted = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * monthShifted + 2) / 5) + 1
  const month = monthShifted < 10 ? monthShifted + 3 : monthShifted - 9
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
  const two = (n: number) => String(n).padStart(2, '0')
  const hh = Math.floor(rest / 3600)
  const mm = Math.floor((rest % 3600) / 60)
  const ss = rest % 60
  return `${year}-${two(month)}-${two(day)}T${two(hh)}:${two(mm)}:${two(ss)}Z`
}

describe('isoOf helper (test scaffolding)', () => {
  test('round-trips through parseIso', () => {
    expect(isoOf(MIDNIGHT)).toBe('2026-11-10T00:00:00Z')
    expect(parseIso(isoOf(NOW + 2 * HOUR_MS + 13 * MINUTE_MS))).toBe(
      NOW + 2 * HOUR_MS + 13 * MINUTE_MS,
    )
  })
})

describe('githubUrl', () => {
  test('https form, with and without .git', () => {
    expect(githubUrl('https://github.com/acme/demo')).toBe('https://github.com/acme/demo')
    expect(githubUrl('https://github.com/acme/demo.git')).toBe('https://github.com/acme/demo')
    expect(githubUrl('https://github.com/acme/demo/')).toBe('https://github.com/acme/demo')
  })

  test('ssh form, with and without .git', () => {
    expect(githubUrl('git@github.com:acme/demo.git')).toBe('https://github.com/acme/demo')
    expect(githubUrl('git@github.com:acme/demo')).toBe('https://github.com/acme/demo')
  })

  test('dots and dashes inside names survive', () => {
    expect(githubUrl('git@github.com:acme-co/demo.js.git')).toBe('https://github.com/acme-co/demo.js')
  })

  test('anything that is not GitHub gives null', () => {
    expect(githubUrl(null)).toBeNull()
    expect(githubUrl('')).toBeNull()
    expect(githubUrl('https://gitlab.com/acme/demo.git')).toBeNull()
    expect(githubUrl('git@gitlab.com:acme/demo.git')).toBeNull()
    expect(githubUrl('https://github.com/acme')).toBeNull()
    expect(githubUrl('https://github.com.example.test/acme/demo')).toBeNull()
  })

  test('a remote carrying credentials is never turned into a link', () => {
    expect(githubUrl('https://user:secret@github.com/acme/demo.git')).toBeNull()
  })
})

describe('paths', () => {
  test('baseName', () => {
    expect(baseName('C:/projects/demo')).toBe('demo')
    expect(baseName('C:\\projects\\demo')).toBe('demo')
    expect(baseName('/srv/projects/demo/')).toBe('demo')
    expect(baseName('demo')).toBe('demo')
    expect(baseName('')).toBe('')
  })

  test('joinPath', () => {
    expect(joinPath('C:/projects/demo', '.git')).toBe('C:/projects/demo/.git')
    expect(joinPath('C:/projects/demo/', '.git')).toBe('C:/projects/demo/.git')
    expect(joinPath('C:\\projects\\demo\\', '.git')).toBe('C:\\projects\\demo/.git')
  })
})

describe('buildSegments', () => {
  const FULL: LineInput = {
    model: 'claude-test-model',
    contextPercent: 18,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 41, resetsAt: isoOf(NOW + 3 * HOUR_MS) },
    ],
    lastActivityMs: lastWithLeftMinutes(18),
    nowMs: NOW,
    root: 'C:/projects/demo',
    remote: 'git@github.com:acme/demo.git',
    isWorktree: true,
  }

  test('everything present: model, context, cache, limit, project, worktree, in this order', () => {
    const segments = buildSegments(FULL)
    expect(segments.map((s) => s.key)).toEqual([
      'model',
      'context',
      'cache',
      'limit',
      'project',
      'worktree',
    ])
    expect(segments.map((s) => s.text)).toEqual([
      'test-model',
      'ctx 18 %',
      'cache 18 min',
      '5h 41 %↑ · 3h 0m',
      'demo',
      'wt demo',
    ])
    expect(segments[0]?.isDim).toBe(true)
  })

  test('the project links to GitHub only for a GitHub remote', () => {
    expect(buildSegments(FULL).find((s) => s.key === 'project')?.href).toBe(
      'https://github.com/acme/demo',
    )
    const other = buildSegments({ ...FULL, remote: 'https://gitlab.com/acme/demo.git' })
    expect(other.find((s) => s.key === 'project')?.href).toBeUndefined()
    const none = buildSegments({ ...FULL, remote: null })
    expect(none.find((s) => s.key === 'project')?.href).toBeUndefined()
  })

  test('before the first refresh there is nothing to show', () => {
    expect(buildSegments({ ...FULL, nowMs: null })).toEqual([])
  })

  test('only what is known: ctx dash and cache dash, no model, no limit, no project', () => {
    const segments = buildSegments({
      model: null,
      contextPercent: null,
      rateLimits: [],
      lastActivityMs: null,
      nowMs: NOW,
      root: null,
      remote: null,
      isWorktree: false,
    })
    expect(segments).toEqual([
      { key: 'context', text: 'ctx –', isDim: true },
      { key: 'cache', text: 'cache –', isDim: true },
    ])
  })

  test('worktree segment needs the flag; main tree shows the project only', () => {
    const keys = buildSegments({ ...FULL, isWorktree: false }).map((s) => s.key)
    expect(keys.includes('worktree')).toBe(false)
    expect(keys.includes('project')).toBe(true)
  })

  test('a running turn flows into the cache segment as a note on the countdown', () => {
    const cache = buildSegments({ ...FULL, isTurnRunning: true }).find((s) => s.key === 'cache')
    expect(cache?.text).toBe('cache 18 min · tah běží')
    const idle = buildSegments({ ...FULL, isTurnRunning: false }).find((s) => s.key === 'cache')
    expect(idle?.text).toBe('cache 18 min')
  })

  test('there is no scratch segment (unavailable in this build)', () => {
    const keys = buildSegments(FULL).map((s) => s.key)
    expect(keys.includes('scratch')).toBe(false)
  })
})

describe('limitSegments', () => {
  const win = (kind: string, percentUsed: number, resetsAt: string | null = null) => ({
    kind,
    percentUsed,
    resetsAt,
  })
  // 5d 11h left of 7 days: 37 h (22.02 %) of the window has passed.
  const weekEnd = isoOf(NOW + 5 * DAY_MS + 11 * HOUR_MS)

  test('order: 5 h, weekly, then per-model, whatever order the windows arrive in', () => {
    const segments = limitSegments(
      [
        win('seven_day:Fable', 5),
        win('seven_day', 22),
        win('five_hour', 41),
        win('seven_day:Sonnet', 7),
      ],
      NOW,
    )
    expect(segments.map((s) => s.key)).toEqual([
      'limit',
      'limit-week',
      'limit-model-Fable',
      'limit-model-Sonnet',
    ])
    expect(segments.map((s) => s.text)).toEqual([
      '5h 41 %',
      'týden 22 %',
      'Fable týd. 5 %',
      'Sonnet týd. 7 %',
    ])
  })

  test('weekly: percent, arrow when ahead of the 7 day clock, reset with days', () => {
    expect(limitSegments([win('seven_day', 23, weekEnd)], NOW)).toEqual([
      { key: 'limit-week', text: 'týden 23 %↑ · 5d 11h', tone: 'success' },
    ])
    expect(limitSegments([win('seven_day', 22, weekEnd)], NOW)[0]?.text).toBe(
      'týden 22 % · 5d 11h',
    )
  })

  test('weekly is shown even at 0 %', () => {
    expect(limitSegments([win('seven_day', 0)], NOW)).toEqual([
      { key: 'limit-week', text: 'týden 0 %', tone: 'success' },
    ])
  })

  test('per-model weekly: only above 0 %, with the arrow but without a reset', () => {
    expect(limitSegments([win('seven_day:Fable', 0, weekEnd)], NOW)).toEqual([])
    expect(limitSegments([win('seven_day:Fable', 25, weekEnd)], NOW)).toEqual([
      { key: 'limit-model-Fable', text: 'Fable týd. 25 %↑', tone: 'success' },
    ])
    expect(limitSegments([win('seven_day:Fable', 12, weekEnd)], NOW)[0]?.text).toBe(
      'Fable týd. 12 %',
    )
  })

  test('a window the account does not report has no segment', () => {
    expect(limitSegments([], NOW)).toEqual([])
    expect(limitSegments([win('seven_day', 22)], NOW).map((s) => s.key)).toEqual(['limit-week'])
    expect(limitSegments([win('five_hour', 22)], NOW).map((s) => s.key)).toEqual(['limit'])
  })

  test('kinds the line does not show are ignored', () => {
    expect(
      limitSegments([win('spend_limit', 90), win('seven_day:', 50), win('other', 5)], NOW),
    ).toEqual([])
  })

  test('of two windows of one kind the first counts; a non-number percent is skipped', () => {
    const segments = limitSegments(
      [win('seven_day', 10), win('seven_day', 90), win('five_hour', Number.NaN)],
      NOW,
    )
    expect(segments.map((s) => s.text)).toEqual(['týden 10 %'])
  })

  test('colour thresholds are the same for every window', () => {
    const tone = (kind: string, p: number) => limitSegments([win(kind, p)], NOW)[0]?.tone
    for (const kind of ['five_hour', 'seven_day', 'seven_day:Fable']) {
      expect(tone(kind, 49.9)).toBe('success')
      expect(tone(kind, 50)).toBe('warning')
      expect(tone(kind, 79.9)).toBe('warning')
      expect(tone(kind, 80)).toBe('error')
    }
  })

  test('an unusable reset time leaves only the percent', () => {
    expect(limitSegments([win('seven_day', 22, 'garbage')], NOW)[0]?.text).toBe('týden 22 %')
    expect(limitSegments([win('seven_day:Fable', 22, null)], NOW)[0]?.text).toBe('Fable týd. 22 %')
  })

  test('fiveHourSegment still returns only the 5 h segment', () => {
    const limits = [win('seven_day', 90), win('five_hour', 10)]
    expect(fiveHourSegment(limits, NOW)?.text).toBe('5h 10 %')
    expect(fiveHourSegment([win('seven_day', 90)], NOW)).toBeNull()
  })
})

describe('kindOfAppLabel', () => {
  test('weekly windows', () => {
    expect(kindOfAppLabel('Weekly · all models')).toBe('seven_day')
    expect(kindOfAppLabel('weekly · ALL MODELS')).toBe('seven_day')
    expect(kindOfAppLabel('Weekly')).toBe('seven_day')
    expect(kindOfAppLabel('Weekly · Fable')).toBe('seven_day:Fable')
    expect(kindOfAppLabel('Weekly - Sonnet')).toBe('seven_day:Sonnet')
    expect(kindOfAppLabel('Fable weekly')).toBe('seven_day:Fable')
  })

  test('"7-day", "7 days" and "7-days" are weekly windows too', () => {
    expect(kindOfAppLabel('7-day')).toBe('seven_day')
    expect(kindOfAppLabel('7 days')).toBe('seven_day')
    expect(kindOfAppLabel('7-days')).toBe('seven_day')
    expect(kindOfAppLabel('7-days · all models')).toBe('seven_day')
    expect(kindOfAppLabel('7-days · Fable')).toBe('seven_day:Fable')
    expect(kindOfAppLabel('7 day Sonnet')).toBe('seven_day:Sonnet')
    expect(kindOfAppLabel('Weeks')).toBe('seven_day')
  })

  test('5 hour window under its usual names', () => {
    expect(kindOfAppLabel('5-hour')).toBe('five_hour')
    expect(kindOfAppLabel('5 hour limit')).toBe('five_hour')
    expect(kindOfAppLabel('5h')).toBe('five_hour')
    expect(kindOfAppLabel('Five hour')).toBe('five_hour')
    expect(kindOfAppLabel('Current session')).toBe('five_hour')
  })

  test('anything else is ignored', () => {
    expect(kindOfAppLabel('Extra usage')).toBeNull()
    expect(kindOfAppLabel('')).toBeNull()
    expect(kindOfAppLabel('15 minutes')).toBeNull()
  })
})

describe('parseAppUsage', () => {
  const SAMPLE = JSON.stringify({
    plan: {
      status: 'ok',
      plan: 'Ultra',
      windows: [
        {
          label: 'Weekly · all models',
          percentUsed: 22,
          resetsAt: '2026-11-15T23:59:59.722Z',
          resetsIn: '5d 11h',
        },
        {
          label: 'Weekly · Fable',
          percentUsed: 0,
          resetsAt: '2026-11-16T00:00:00.000Z',
          resetsIn: '5d 11h',
        },
      ],
      extraUsage: { enabled: false, currency: 'USD' },
    },
    context: {
      session: 'self',
      status: 'ok',
      tokensUsed: 308762,
      contextWindow: 400000,
      percentUsed: 77,
      autoCompactsAtPercent: 92,
      categories: [],
    },
  })

  test('the real sample: two weekly windows and the context percent', () => {
    expect(parseAppUsage(SAMPLE)).toEqual({
      windows: [
        { kind: 'seven_day', percentUsed: 22, resetsAt: '2026-11-15T23:59:59.722Z' },
        { kind: 'seven_day:Fable', percentUsed: 0, resetsAt: '2026-11-16T00:00:00.000Z' },
      ],
      contextPercent: 77,
    })
  })

  test('plan not_applicable or unavailable: no windows, the context still counts', () => {
    for (const status of ['not_applicable', 'unavailable']) {
      const text = JSON.stringify({
        plan: { status },
        context: { status: 'ok', percentUsed: 31 },
      })
      expect(parseAppUsage(text)).toEqual({ windows: [], contextPercent: 31 })
    }
  })

  test('context unavailable: no percent, the windows still count', () => {
    const text = JSON.stringify({
      plan: { status: 'ok', windows: [{ label: '5-hour', percentUsed: 41, resetsAt: null }] },
      context: { status: 'unavailable' },
    })
    expect(parseAppUsage(text)).toEqual({
      windows: [{ kind: 'five_hour', percentUsed: 41, resetsAt: null }],
      contextPercent: null,
    })
  })

  test('broken or foreign JSON gives nothing', () => {
    const none = { windows: [], contextPercent: null }
    expect(parseAppUsage('')).toEqual(none)
    expect(parseAppUsage('{"plan":')).toEqual(none)
    expect(parseAppUsage('not json')).toEqual(none)
    expect(parseAppUsage('null')).toEqual(none)
    expect(parseAppUsage('42')).toEqual(none)
    expect(parseAppUsage('[]')).toEqual(none)
    expect(parseAppUsage('{}')).toEqual(none)
    expect(parseAppUsage('{"plan":{"status":"ok","windows":"nope"},"context":[]}')).toEqual(none)
  })

  test('an unknown label is ignored, the known ones stay', () => {
    const text = JSON.stringify({
      plan: {
        status: 'ok',
        windows: [
          { label: 'Extra usage', percentUsed: 5, resetsAt: null },
          { label: 'Weekly · all models', percentUsed: 9, resetsAt: null },
        ],
      },
    })
    expect(parseAppUsage(text).windows).toEqual([
      { kind: 'seven_day', percentUsed: 9, resetsAt: null },
    ])
  })

  test('damaged windows are skipped one by one', () => {
    const text = JSON.stringify({
      plan: {
        status: 'ok',
        windows: [
          null,
          'x',
          { percentUsed: 5 },
          { label: 7, percentUsed: 5 },
          { label: 'Weekly', percentUsed: '5' },
          { label: 'Weekly', percentUsed: -1 },
          { label: '5h', percentUsed: 12, resetsAt: 'tomorrow' },
          { label: 'Weekly', percentUsed: 30, resetsAt: '2026-11-15T23:59:59Z' },
          { label: 'Weekly', percentUsed: 99 },
        ],
      },
    })
    expect(parseAppUsage(text).windows).toEqual([
      { kind: 'five_hour', percentUsed: 12, resetsAt: null },
      { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-11-15T23:59:59Z' },
    ])
  })

  test('context percent must be a number; it is capped at 100', () => {
    const ctx = (percentUsed: unknown) =>
      parseAppUsage(JSON.stringify({ context: { status: 'ok', percentUsed } })).contextPercent
    expect(ctx(0)).toBe(0)
    expect(ctx(77)).toBe(77)
    expect(ctx(130)).toBe(100)
    expect(ctx('77')).toBeNull()
    expect(ctx(null)).toBeNull()
    expect(ctx(-3)).toBeNull()
  })
})

describe('app reading helpers', () => {
  test('firstTextBlock: the first text block, else null', () => {
    expect(firstTextBlock([{ type: 'text', text: '{"a":1}' }])).toBe('{"a":1}')
    expect(
      firstTextBlock([
        { type: 'image', mimeType: 'image/png' },
        { type: 'text', text: 'second' },
        { type: 'text', text: 'third' },
      ]),
    ).toBe('second')
    expect(firstTextBlock([])).toBeNull()
    expect(firstTextBlock([{ type: 'text' }])).toBeNull()
    expect(firstTextBlock(undefined)).toBeNull()
    expect(firstTextBlock('text')).toBeNull()
  })

  test('errorText: message of an error or a string, at most 120 characters', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText({ message: 'shaped like an error' })).toBe('shaped like an error')
    expect(errorText(42)).toBe('error')
    expect(errorText(new Error(''))).toBe('error')
    expect(errorText('x'.repeat(300)).length).toBe(120)
  })

  test('isFresh: younger than 5 min only', () => {
    expect(isFresh(null, NOW)).toBe(false)
    expect(isFresh(NOW, NOW)).toBe(true)
    expect(isFresh(NOW - APP_FRESH_MS + 1, NOW)).toBe(true)
    expect(isFresh(NOW - APP_FRESH_MS, NOW)).toBe(false)
    expect(isFresh(NOW - 10 * MINUTE_MS, NOW)).toBe(false)
  })

  test('usageSource: app while either reading is fresh, else engine', () => {
    expect(usageSource(null, null, NOW)).toBe('engine')
    expect(usageSource(NOW - MINUTE_MS, null, NOW)).toBe('app')
    expect(usageSource(null, NOW - MINUTE_MS, NOW)).toBe('app')
    expect(usageSource(NOW - 6 * MINUTE_MS, NOW - 6 * MINUTE_MS, NOW)).toBe('engine')
    expect(usageSource(NOW, NOW, null)).toBe('engine')
  })
})

describe('buildSegments with the app limits', () => {
  test('order: model, ctx, cache, 5h, week, per-model, project, wt', () => {
    const segments = buildSegments({
      model: 'claude-test-model',
      contextPercent: 77,
      rateLimits: [
        { kind: 'seven_day:Fable', percentUsed: 12, resetsAt: null },
        { kind: 'seven_day', percentUsed: 23, resetsAt: isoOf(NOW + 5 * DAY_MS + 11 * HOUR_MS) },
        { kind: 'five_hour', percentUsed: 41, resetsAt: isoOf(NOW + 3 * HOUR_MS) },
      ],
      lastActivityMs: lastWithLeftMinutes(18),
      nowMs: NOW,
      root: 'C:/projects/demo',
      remote: null,
      isWorktree: true,
    })
    expect(segments.map((s) => s.key)).toEqual([
      'model',
      'context',
      'cache',
      'limit',
      'limit-week',
      'limit-model-Fable',
      'project',
      'worktree',
      'compact',
    ])
    expect(segments.map((s) => s.text)).toEqual([
      'test-model',
      'ctx 77 %',
      'cache 18 min',
      '5h 41 %↑ · 3h 0m',
      'týden 23 %↑ · 5d 11h',
      'Fable týd. 12 %',
      'demo',
      'wt demo',
      '→ /compact',
    ])
  })

  test('a per-model window with nothing used is left out', () => {
    const keys = buildSegments({
      model: null,
      contextPercent: 5,
      rateLimits: [{ kind: 'seven_day:Fable', percentUsed: 0, resetsAt: null }],
      lastActivityMs: null,
      nowMs: NOW,
      root: null,
      remote: null,
      isWorktree: false,
    }).map((s) => s.key)
    expect(keys).toEqual(['context', 'cache'])
  })
})

describe('readSettings', () => {
  test('missing options give the defaults: safeguard off, flush text "compact", 60 minutes, Czech', () => {
    expect(readSettings({})).toEqual({
      guard: 'off',
      flushText: 'compact',
      cacheTtlMinutes: 60,
      language: 'cs',
    })
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings('guard')).toEqual(DEFAULT_SETTINGS)
    expect(readSettings(['compact'])).toEqual(DEFAULT_SETTINGS)
  })

  test('valid values are taken over', () => {
    expect(
      readSettings({ guard: 'flush-then-compact', flushText: 'save notes', cacheTtlMinutes: 5, language: 'en' }),
    ).toEqual({ guard: 'flush-then-compact', flushText: 'save notes', cacheTtlMinutes: 5, language: 'en' })
    expect(readSettings({ guard: 'compact' }).guard).toBe('compact')
    expect(readSettings({ guard: 'off' }).guard).toBe('off')
  })

  test('an invalid guard or language falls back to the safe default', () => {
    expect(readSettings({ guard: 'always' }).guard).toBe('off')
    expect(readSettings({ guard: true }).guard).toBe('off')
    expect(readSettings({ guard: 3 }).guard).toBe('off')
    expect(readSettings({ language: 'de' }).language).toBe('cs')
    expect(readSettings({ language: 7 }).language).toBe('cs')
  })

  test('words are trimmed and matched without regard to case', () => {
    expect(readSettings({ guard: '  Compact ' }).guard).toBe('compact')
    expect(readSettings({ language: 'EN' }).language).toBe('en')
    expect(readSettings({ flushText: '  hello  ' }).flushText).toBe('hello')
  })

  test('a blank, non-text or absurdly long flush text becomes "compact"', () => {
    expect(readSettings({ flushText: '' }).flushText).toBe('compact')
    expect(readSettings({ flushText: '   ' }).flushText).toBe('compact')
    expect(readSettings({ flushText: 12 }).flushText).toBe('compact')
    expect(readSettings({ flushText: 'x'.repeat(501) }).flushText).toBe('compact')
    expect(readSettings({ flushText: 'x'.repeat(500) }).flushText).toBe('x'.repeat(500))
  })

  test('the cache lifetime is a positive whole number of minutes, at most a day', () => {
    expect(readSettings({ cacheTtlMinutes: 5 }).cacheTtlMinutes).toBe(5)
    expect(readSettings({ cacheTtlMinutes: 90.4 }).cacheTtlMinutes).toBe(90)
    expect(readSettings({ cacheTtlMinutes: '45' }).cacheTtlMinutes).toBe(45)
    expect(readSettings({ cacheTtlMinutes: 0.6 }).cacheTtlMinutes).toBe(1)
    expect(readSettings({ cacheTtlMinutes: 99999 }).cacheTtlMinutes).toBe(1440)
  })

  test('an invalid cache lifetime falls back to 60', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'soon', '', true, null, [60]]) {
      expect(readSettings({ cacheTtlMinutes: bad }).cacheTtlMinutes).toBe(60)
    }
  })
})

describe('cacheThresholds', () => {
  test('25 and 10 minutes for the hour, scaled to the lifetime, at least one minute', () => {
    expect(cacheThresholds(60)).toEqual({ warn: 25, red: 10 })
    expect(cacheThresholds(30)).toEqual({ warn: 13, red: 5 })
    expect(cacheThresholds(5)).toEqual({ warn: 2, red: 1 })
    expect(cacheThresholds(1)).toEqual({ warn: 1, red: 1 })
    expect(cacheThresholds(120)).toEqual({ warn: 50, red: 20 })
  })
})

describe('the cache lifetime option in the drawing', () => {
  const FIVE = { cacheTtlMinutes: 5, language: 'cs' as const }
  const lastFive = (leftMinutes: number): number => NOW - (5 - leftMinutes) * MINUTE_MS

  test('a 5 minute lifetime counts down from 5: green, yellow from 2, red from 1, then cold', () => {
    expect(cacheSegment(lastFive(5), NOW, false, FIVE)).toEqual({ key: 'cache', text: 'cache 5 min', tone: 'success' })
    expect(cacheSegment(lastFive(3), NOW, false, FIVE).tone).toBe('success')
    expect(cacheSegment(lastFive(2), NOW, false, FIVE).tone).toBe('warning')
    expect(cacheSegment(lastFive(1), NOW, false, FIVE)).toEqual({ key: 'cache', text: 'cache 1 min', tone: 'error' })
    expect(cacheSegment(lastFive(0), NOW, false, FIVE).text).toBe('cache studená')
  })

  test('a last activity in the future never promises more than the configured lifetime', () => {
    expect(cacheSegment(NOW + 10 * MINUTE_MS, NOW, false, FIVE).text).toBe('cache 5 min')
  })

  test('a 120 minute lifetime: 90 minutes are still green, 50 yellow, 20 red', () => {
    const settings = { cacheTtlMinutes: 120, language: 'cs' as const }
    const last = (left: number): number => NOW - (120 - left) * MINUTE_MS
    expect(cacheSegment(last(90), NOW, false, settings).tone).toBe('success')
    expect(cacheSegment(last(50), NOW, false, settings).tone).toBe('warning')
    expect(cacheSegment(last(20), NOW, false, settings).tone).toBe('error')
  })

  test('the compact hint for a nearly cold cache follows the red threshold of the lifetime', () => {
    const thirty = { cacheTtlMinutes: 30, language: 'cs' as const }
    const last = (left: number): number => NOW - (30 - left) * MINUTE_MS
    expect(compactSegment(40, last(6), NOW, false, 'idle', thirty)).toBeNull()
    expect(compactSegment(40, last(5), NOW, false, 'idle', thirty)?.action).toBe('compact')
    expect(compactSegment(40, lastFive(1), NOW, false, 'idle', FIVE)?.action).toBe('compact')
    expect(compactSegment(40, lastFive(2), NOW, false, 'idle', FIVE)).toBeNull()
  })

  test('buildSegments takes the lifetime and the language from the settings', () => {
    const segments = buildSegments({
      model: null,
      contextPercent: 18,
      rateLimits: [],
      lastActivityMs: lastFive(2),
      nowMs: NOW,
      root: null,
      remote: null,
      isWorktree: false,
      settings: { guard: 'off', flushText: 'compact', cacheTtlMinutes: 5, language: 'en' },
    })
    expect(segments.find((s) => s.key === 'cache')).toEqual({ key: 'cache', text: 'cache 2 min', tone: 'warning' })
  })
})

describe('isGuardDue with the cache lifetime option', () => {
  test('a 30 minute lifetime: due from 5 minutes left down to 2', () => {
    const thirty = { cacheTtlMinutes: 30 }
    const last = (left: number): number => NOW - (30 - left) * MINUTE_MS
    expect(isGuardDue(40, last(6), NOW, false, thirty)).toBe(false)
    expect(isGuardDue(40, last(5), NOW, false, thirty)).toBe(true)
    expect(isGuardDue(40, last(2), NOW, false, thirty)).toBe(true)
    expect(isGuardDue(40, last(1), NOW, false, thirty)).toBe(false)
  })

  test('a lifetime under 30 minutes is never due: a flush turn would not fit', () => {
    for (const minutes of [1, 5, 29]) {
      const settings = { cacheTtlMinutes: minutes }
      for (let left = 0; left <= minutes; left++) {
        expect(isGuardDue(40, NOW - (minutes - left) * MINUTE_MS, NOW, false, settings)).toBe(false)
      }
    }
  })

  test('a 120 minute lifetime: due from 20 minutes left', () => {
    const settings = { cacheTtlMinutes: 120 }
    const last = (left: number): number => NOW - (120 - left) * MINUTE_MS
    expect(isGuardDue(40, last(21), NOW, false, settings)).toBe(false)
    expect(isGuardDue(40, last(20), NOW, false, settings)).toBe(true)
  })
})

describe('effectiveGuardMode', () => {
  test('the chosen mode while the cache lives 30 minutes or more', () => {
    expect(effectiveGuardMode({ guard: 'compact', cacheTtlMinutes: 60 })).toBe('compact')
    expect(effectiveGuardMode({ guard: 'flush-then-compact', cacheTtlMinutes: 30 })).toBe('flush-then-compact')
    expect(effectiveGuardMode({ guard: 'off', cacheTtlMinutes: 60 })).toBe('off')
  })

  test('off, whatever the option says, under 30 minutes', () => {
    expect(effectiveGuardMode({ guard: 'compact', cacheTtlMinutes: 29 })).toBe('off')
    expect(effectiveGuardMode({ guard: 'flush-then-compact', cacheTtlMinutes: 5 })).toBe('off')
  })
})

describe('labels in two languages', () => {
  test('Czech is the default', () => {
    expect(labelsFor('cs')).toEqual({
      week: 'týden',
      weekModel: 'týd.',
      turnRunning: 'tah běží',
      cacheCold: 'cache studená',
      compacting: 'compactuji…',
    })
  })

  test('English words for the same places', () => {
    const en = { ...DEFAULT_SETTINGS, language: 'en' as const }
    expect(cacheSegment(lastWithLeftMinutes(-5), NOW, false, en).text).toBe('cache cold')
    expect(cacheSegment(lastWithLeftMinutes(18), NOW, true, en).text).toBe('cache 18 min · turn running')
    expect(compactSegment(10, null, NOW, false, 'running', en)?.text).toBe('compacting…')
    const limits = [
      { kind: 'seven_day', percentUsed: 22, resetsAt: isoOf(NOW + 5 * DAY_MS + 11 * HOUR_MS) },
      { kind: 'seven_day:Fable', percentUsed: 12, resetsAt: null },
    ]
    expect(limitSegments(limits, NOW, en).map((s) => s.text)).toEqual([
      'week 22 % · 5d 11h',
      'Fable wk 12 %',
    ])
    expect(limitSegments(limits, NOW).map((s) => s.text)).toEqual([
      'týden 22 % · 5d 11h',
      'Fable týd. 12 %',
    ])
  })
})

describe('isPersonPrompt', () => {
  test('the person: composer, remote control, the app host, Slack ping, click follow-up, unclassified', () => {
    for (const kind of ['composer', 'bridge', 'sdk', 'slack-ping', 'auto-continuation', 'unclassified']) {
      expect(isPersonPrompt({ kind })).toBe(true)
    }
  })

  test('not the person: plugins (also as the person), other sessions, notifications, schedules, channels', () => {
    expect(isPersonPrompt({ kind: 'plugin', name: 'stavovy-radek' })).toBe(false)
    expect(isPersonPrompt({ kind: 'plugin', name: 'stavovy-radek', asUser: true })).toBe(false)
    for (const kind of [
      'peer',
      'peer-send-message',
      'projects-relay',
      'task-notification',
      'scheduled-trigger',
      'coordinator',
      'observer',
      'observer-activity',
    ]) {
      expect(isPersonPrompt({ kind })).toBe(false)
    }
    expect(isPersonPrompt({ kind: 'channel', server: 'chat' })).toBe(false)
  })

  test('a kind this version does not know, a missing or malformed origin: not the person', () => {
    expect(isPersonPrompt({ kind: 'something-new' })).toBe(false)
    expect(isPersonPrompt(undefined)).toBe(false)
    expect(isPersonPrompt(null)).toBe(false)
    expect(isPersonPrompt('composer')).toBe(false)
    expect(isPersonPrompt({ kind: 3 })).toBe(false)
  })

  test('a prompt the person does not see as typed (isMeta) is not theirs, whatever the origin', () => {
    expect(isPersonPrompt({ kind: 'composer' }, true)).toBe(false)
    expect(isPersonPrompt({ kind: 'unclassified' }, true)).toBe(false)
    expect(isPersonPrompt({ kind: 'composer' }, false)).toBe(true)
  })
})
