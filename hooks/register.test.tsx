import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'
import type { McpToolResult, On, SessionUsage, UsageUnit } from 'claude-code'

// Everything here is invented: a made-up project folder and a made-up GitHub
// repository. Nothing is read from the real machine or its environment.

// 2026-11-10T12:00:00Z
const NOW = 1794312000000
const MINUTE = 60 * 1000
const ROOT = 'C:/projects/demo'
const GITHUB_REMOTE = 'git@github.com:acme/demo.git'

/** Window ends in 3 h: 40 % of it has passed, so 41 % used is ahead of the clock. */
const AHEAD = [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-11-10T15:00:00Z' }]
/** Window ends in 2 h 13 m: 55.7 % of it has passed, so 41 % used is behind the clock. */
const BEHIND = [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-11-10T14:13:00Z' }]

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
}

type World = {
  model: string
  /** null: every read of usage is refused. */
  usage: SessionUsage | null
  remote: string | null
  /** What `<root>/.git` is; null: no such path (the stat is refused). */
  gitKind: 'file' | 'dir' | null
  /** The reply of the app's `get_usage` call; null: the call is refused. */
  app: McpToolResult | null
  /** Every `$.mcp.call` the mod made, in order. */
  appCalls: { server: string; tool: string }[]
  /** How often the mod read the model, the root, the repository and `.git`. */
  reads: { model: number; root: number; repo: number; stat: number }
}

function usageOf(percent: number | undefined, rateLimits: SessionUsage['rateLimits']): SessionUsage {
  return {
    startedAt: NOW,
    context:
      percent === undefined
        ? { window: 200000 }
        : { window: 200000, tokens: percent * 2000, percent },
    rateLimits,
  }
}

function world(overrides: Partial<World> = {}): World {
  return {
    model: 'claude-test-model',
    usage: usageOf(18, AHEAD),
    remote: GITHUB_REMOTE,
    gitKind: 'dir',
    app: null,
    appCalls: [],
    reads: { model: 0, root: 0, repo: 0, stat: 0 },
    ...overrides,
  }
}

/** The app's `get_usage` reply in the shape the app returns it (numbers invented). */
function appUsage(
  options: { fable?: number; contextPercent?: number; planStatus?: string } = {},
): McpToolResult {
  const body = {
    plan: {
      status: options.planStatus ?? 'ok',
      plan: 'Test plan',
      windows: [
        {
          label: 'Weekly · all models',
          percentUsed: 22,
          resetsAt: '2026-11-15T23:59:59.722Z',
          resetsIn: '5d 11h',
        },
        {
          label: 'Weekly · Fable',
          percentUsed: options.fable ?? 0,
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
      percentUsed: options.contextPercent ?? 77,
      autoCompactsAtPercent: 92,
      categories: [],
    },
  }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false }
}

/** Answers what the mod reads from the session, beneath every plugin. */
function install(on: On, w: World): void {
  on('session.model', () => {
    w.reads.model += 1
    return { value: w.model }
  })
  on('session.root', () => {
    w.reads.root += 1
    return { value: ROOT }
  })
  on('session.repo', () => {
    w.reads.repo += 1
    return { value: { root: ROOT, remote: w.remote, internal: false, name: null } }
  })
  on('session.usage', () => (w.usage === null ? { deny: 'unavailable' } : { value: w.usage }))
  on('mcp.call', (_$, e) => {
    w.appCalls.push({ server: e.server, tool: e.tool })
    return w.app === null ? { deny: 'app unavailable' } : { value: w.app }
  })
  on('fs.stat', () => {
    w.reads.stat += 1
    return w.gitKind === null
      ? { deny: 'ENOENT' }
      : { value: { kind: w.gitKind, size: 0, mtimeMs: 0, isLink: false } }
  })
  // The mod calls next(e) in these; the test supplies the bottom of each chain.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // Stands for the engine's own band: what the mod gets back from next(e) when it steps aside.
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
}

async function boot($: Engine, on: On, w: World, extra?: (on: On) => void) {
  const clock = mock.clock(on, { now: NOW })
  install(on, w)
  if (extra !== undefined) extra(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

function mountBand($: Engine, props = BAND) {
  return $.ui.mount({
    plugin: 'stavovy-radek',
    surface: 'terminal',
    component: 'AbovePrompt',
    props,
  })
}

type Mounted = Awaited<ReturnType<typeof mountBand>>

/** The innermost element (shortest text) that shows the pattern: one segment of the line. */
async function leaf(ui: Mounted, pattern: RegExp): Promise<FoundElement | undefined> {
  const all = await ui.findAll({ text: pattern })
  const sorted = [...all].sort((a, b) => a.text.length - b.text.length)
  return sorted[0]
}

async function turnDone($: Engine, agentId?: string) {
  const base = { answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' as const }
  return $.turn.complete(agentId === undefined ? base : { ...base, agentId })
}

async function turnBegins($: Engine, agentId?: string) {
  const base = { text: 'hello', turnId: 't1' }
  return $.turn.start(agentId === undefined ? base : { ...base, agentId })
}

describe('the band above the prompt', () => {
  test('draws model, context and the 5 h limit with the arrow', async ($, on) => {
    await boot($, on, world())
    const ui = await mountBand($)
    expect(await leaf(ui, /test-model/)).toBeDefined()
    expect((await leaf(ui, /ctx 18 %/))?.text).toBe('ctx 18 %')
    expect((await leaf(ui, /5h 41 %↑/))?.text).toBe('5h 41 %↑ · 3h 0m')
    await ui.unmount()
  })

  test('no arrow when the consumption is behind the elapsed time', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, BEHIND) }))
    const ui = await mountBand($)
    expect((await leaf(ui, /5h 41 %/))?.text).toBe('5h 41 % · 2h 13m')
    await ui.unmount()
  })

  test('the same band is accepted on the terminal and on the desktop surface', async ($, on) => {
    await boot($, on, world())
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'stavovy-radek',
        surface,
        component: 'AbovePrompt',
        props: BAND,
      })
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      expect(await ui.find({ text: /ctx 18 %/ })).toBeDefined()
      expect(await ui.find({ text: /5h 41 %↑/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('segments are separated by a dim bar', async ($, on) => {
    await boot($, on, world())
    const ui = await mountBand($)
    const separators = await ui.findAll({ text: ' │ ' })
    expect(separators.length).toBeGreaterThan(0)
    await ui.unmount()
  })

  test('draws nothing of its own when a survey holds the band', async ($, on) => {
    await boot($, on, world())
    const ui = await mountBand($, { ...BAND, hasSurvey: true })
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    expect(await ui.find({ text: /test-model/ })).toBeUndefined()
    expect(await ui.find({ text: /ctx/ })).toBeUndefined()
    await ui.unmount()
  })

  test('draws nothing of its own before the first refresh', async ($, on) => {
    mock.clock(on, { now: NOW })
    install(on, world())
    const ui = await mountBand($)
    expect(await ui.find({ text: 'engine band' })).toBeDefined()
    expect(await ui.find({ text: /ctx/ })).toBeUndefined()
    expect(await ui.find({ text: /test-model/ })).toBeUndefined()
    await ui.unmount()
  })

  test('draws its own band, not the engine fallback, when there is something to show', async ($, on) => {
    await boot($, on, world())
    const ui = await mountBand($)
    expect(await ui.find({ text: 'engine band' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('context colour', () => {
  test('green below 50, yellow below 80, red from 80 (49.9 / 50 / 79.9 / 80)', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    const cases = [
      { percent: 49.9, text: 'ctx 49 %', color: 'success' },
      { percent: 50, text: 'ctx 50 %', color: 'warning' },
      { percent: 79.9, text: 'ctx 79 %', color: 'warning' },
      { percent: 80, text: 'ctx 80 %', color: 'error' },
    ]
    for (const c of cases) {
      await $.session.measure({
        context: { window: 200000, tokens: c.percent * 2000, percent: c.percent },
        rateLimits: [],
        changed: ['context'],
      })
      const ui = await mountBand($)
      const segment = await leaf(ui, /ctx/)
      expect(segment?.text).toBe(c.text)
      expect(segment?.props['color']).toBe(c.color)
      await ui.unmount()
    }
  })

  test('unknown fill shows a dim dash', async ($, on) => {
    await boot($, on, world({ usage: usageOf(undefined, []) }))
    const ui = await mountBand($)
    const segment = await leaf(ui, /ctx/)
    expect(segment?.text).toBe('ctx –')
    expect(segment?.props['dimColor']).toBe(true)
    await ui.unmount()
  })
})

describe('5 h limit', () => {
  test('colour follows the percent; reading arrives through session.measure', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    const cases = [
      { percent: 49.9, color: 'success' },
      { percent: 50, color: 'warning' },
      { percent: 80, color: 'error' },
    ]
    for (const c of cases) {
      await $.session.measure({
        context: { window: 200000, tokens: 36000, percent: 18 },
        rateLimits: [{ kind: 'five_hour', percentUsed: c.percent, resetsAt: '2026-11-10T14:13:00Z' }],
        changed: ['rateLimits'],
      })
      const ui = await mountBand($)
      expect((await leaf(ui, /5h/))?.props['color']).toBe(c.color)
      await ui.unmount()
    }
  })

  test('a plan without limits has no 5 h segment', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    const ui = await mountBand($)
    expect(await ui.find({ text: /5h/ })).toBeUndefined()
    expect(await leaf(ui, /ctx 18 %/)).toBeDefined()
    await ui.unmount()
  })
})

describe('prompt cache countdown', () => {
  test('always drawn: dash while unknown, then green, yellow from 25, red from 10, cold at 0', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    const shown = async () => {
      const ui = await mountBand($)
      const segment = await leaf(ui, /cache/)
      await ui.unmount()
      return segment
    }

    // last activity unknown: a dim dash, the segment is there
    const unknown = await shown()
    expect(unknown?.text).toBe('cache –')
    expect(unknown?.props['dimColor']).toBe(true)

    await turnDone($)
    // just now: 60 minutes left, green
    const fresh = await shown()
    expect(fresh?.text).toBe('cache 60 min')
    expect(fresh?.props['color']).toBe('success')

    await clock.advance(34 * MINUTE) // 26 minutes left
    const green = await shown()
    expect(green?.text).toBe('cache 26 min')
    expect(green?.props['color']).toBe('success')

    await clock.advance(1 * MINUTE) // 25 minutes left
    const yellow = await shown()
    expect(yellow?.text).toBe('cache 25 min')
    expect(yellow?.props['color']).toBe('warning')

    await clock.advance(15 * MINUTE) // 10 minutes left
    const red = await shown()
    expect(red?.text).toBe('cache 10 min')
    expect(red?.props['color']).toBe('error')

    await clock.advance(10 * MINUTE) // 0 minutes left
    const cold = await shown()
    expect(cold?.text).toBe('cache studená')
    expect(cold?.props['color']).toBe('error')
  })

  test('a subagent turn does not count as activity of the window', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($, 'agent-1')
    await clock.advance(40 * MINUTE)
    const ui = await mountBand($)
    expect((await leaf(ui, /cache/))?.text).toBe('cache –')
    await ui.unmount()
  })
})

describe('prompt cache countdown while a turn runs (turn.start, turn.complete)', () => {
  async function cacheNow($: Engine): Promise<FoundElement | undefined> {
    const ui = await mountBand($)
    const segment = await leaf(ui, /cache/)
    await ui.unmount()
    return segment
  }

  test('the start of a turn is a model request: the countdown starts over and carries the note', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($) // an earlier turn: last activity NOW
    await clock.advance(30 * MINUTE)
    expect((await cacheNow($))?.text).toBe('cache 30 min')

    await turnBegins($)
    const started = await cacheNow($)
    expect(started?.text).toBe('cache 60 min · tah běží')
    expect(started?.props['color']).toBe('success')

    await clock.advance(1 * MINUTE)
    expect((await cacheNow($))?.text).toBe('cache 59 min · tah běží')
  })

  test('a running turn counts down like an idle window: yellow, red, then cold', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnBegins($)
    await clock.advance(41 * MINUTE)
    const yellow = await cacheNow($)
    expect(yellow?.text).toBe('cache 19 min · tah běží')
    expect(yellow?.props['color']).toBe('warning')

    await clock.advance(10 * MINUTE)
    const red = await cacheNow($)
    expect(red?.text).toBe('cache 9 min · tah běží')
    expect(red?.props['color']).toBe('error')
  })

  test('a turn blocked for hours (a question to the person) shows a cold cache, not a warm one', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnBegins($)
    await clock.advance(3 * 60 * MINUTE)
    const blocked = await cacheNow($)
    expect(blocked?.text).toBe('cache studená · tah běží')
    expect(blocked?.props['color']).toBe('error')
  })

  test('a model response inside the running turn (session.measure) renews the countdown', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    const measure = (changed: UsageUnit[]) =>
      $.session.measure({
        context: { window: 200000, tokens: 36000, percent: 18 },
        rateLimits: [],
        changed,
      })
    await measure(['context', 'cost']) // the first one after the start: not a response
    await turnBegins($)
    await clock.advance(50 * MINUTE)
    expect((await cacheNow($))?.text).toBe('cache 10 min · tah běží')

    await measure(['cost'])
    expect((await cacheNow($))?.text).toBe('cache 60 min · tah běží')
  })

  test('the end of the turn starts the countdown over from that moment', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnBegins($)
    await clock.advance(50 * MINUTE)
    await turnDone($)
    expect((await cacheNow($))?.text).toBe('cache 60 min')

    await clock.advance(36 * MINUTE)
    expect((await cacheNow($))?.text).toBe('cache 24 min')
  })

  test('an interrupted turn clears the flag as well', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnBegins($)
    await clock.advance(3 * MINUTE)
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' })
    await clock.advance(5 * MINUTE)
    expect((await cacheNow($))?.text).toBe('cache 55 min')
  })

  test("a subagent turn neither starts nor ends the window's turn", async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($)
    await clock.advance(20 * MINUTE)

    await turnBegins($, 'agent-1')
    expect((await cacheNow($))?.text).toBe('cache 40 min')

    await turnBegins($)
    await turnDone($, 'agent-1')
    expect((await cacheNow($))?.text).toBe('cache 60 min · tah běží')
  })

  test('a new session.start clears a flag left over from a window that never ended its turn', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnBegins($)
    expect((await cacheNow($))?.text).toBe('cache 60 min · tah běží')
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    // the note is gone; the activity time the turn start recorded stays
    expect((await cacheNow($))?.text).toBe('cache 60 min')
  })

  test('the turn.start result passes through unchanged', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    const result = await turnBegins($)
    expect(result.turnId).toBe('t1')
  })
})

describe('prompt cache countdown follows model responses (session.measure)', () => {
  /** A measurement as the engine raises it after a response; only `changed` matters here. */
  function measureOf($: Engine, changed: UsageUnit[]) {
    return $.session.measure({
      context: { window: 200000, tokens: 36000, percent: 18 },
      rateLimits: [],
      changed,
    })
  }

  /** The cache segment as the band draws it now. */
  async function cacheNow($: Engine): Promise<FoundElement | undefined> {
    const ui = await mountBand($)
    const segment = await leaf(ui, /cache/)
    await ui.unmount()
    return segment
  }

  test('the first measurement after the start does not move the last activity', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($) // last activity: NOW
    await clock.advance(10 * MINUTE)

    // The first measurement names every unit it has a figure for: not a response.
    await measureOf($, ['context', 'cost'])
    await clock.advance(25 * MINUTE) // 35 min after the turn; had the measurement counted: 25 min

    expect((await cacheNow($))?.text).toBe('cache 25 min')
  })

  test('a first measurement alone leaves an unknown last activity unknown', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await measureOf($, ['context', 'cost', 'rateLimits'])
    await clock.advance(40 * MINUTE)
    expect((await cacheNow($))?.text).toBe('cache –')
  })

  test('a later measurement with a changed cost moves the last activity to now', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($) // last activity: NOW
    await measureOf($, ['context', 'cost']) // the first one: ignored
    await clock.advance(20 * MINUTE)

    await measureOf($, ['cost']) // a response inside a long turn
    await clock.advance(35 * MINUTE) // 35 min after the measurement, 55 min after the turn

    const segment = await cacheNow($)
    expect(segment?.text).toBe('cache 25 min')
    expect(segment?.props['color']).toBe('warning')
  })

  test('a later measurement with a changed context moves it as well', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($)
    await measureOf($, ['rateLimits'])
    await clock.advance(20 * MINUTE)

    await measureOf($, ['context'])
    await clock.advance(35 * MINUTE)

    expect((await cacheNow($))?.text).toBe('cache 25 min')
  })

  test('a measurement that moved only the rate limits does not touch it', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($) // last activity: NOW
    await measureOf($, ['context', 'cost']) // the first one: ignored
    await clock.advance(20 * MINUTE)

    await measureOf($, ['rateLimits'])
    await clock.advance(35 * MINUTE) // 55 min after the turn; had it counted: 25 min

    const segment = await cacheNow($)
    expect(segment?.text).toBe('cache 5 min')
    expect(segment?.props['color']).toBe('error')
  })

  test('a new session.start forgets the first measurement (resume, restart, hot reload)', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($) // last activity: NOW
    await measureOf($, ['context']) // the first one: ignored
    await clock.advance(20 * MINUTE)

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await measureOf($, ['context', 'cost']) // the first one of the new start: ignored again
    await clock.advance(35 * MINUTE) // 55 min after the turn; had it counted: 25 min

    expect((await cacheNow($))?.text).toBe('cache 5 min')
  })

  test('the measurement result passes through unchanged', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    await measureOf($, ['context']) // marks the flag
    const result = await measureOf($, ['cost'])
    expect(result.changed).toEqual(['cost'])
  })
})

describe('compact hint', () => {
  async function hintNow($: Engine): Promise<FoundElement | undefined> {
    const ui = await mountBand($)
    // The hint is a Button (v0.3.6) holding the coloured Text: the colour is read off the Text.
    const segment = await ui.find({ type: 'Text', text: /compact/ })
    await ui.unmount()
    return segment
  }

  test('no hint while the context is low and the cache is fresh', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    await turnDone($)
    expect(await hintNow($)).toBeUndefined()
  })

  test('from 70 % of the context: yellow hint, red from 80, last on the line', async ($, on) => {
    await boot($, on, world({ usage: usageOf(70, []) }))
    const yellow = await hintNow($)
    expect(yellow?.text).toBe('→ /compact')
    expect(yellow?.props['color']).toBe('warning')

    await $.session.measure({
      context: { window: 200000, tokens: 160000, percent: 80 },
      rateLimits: [],
      changed: ['context'],
    })
    const red = await hintNow($)
    expect(red?.text).toBe('→ /compact')
    expect(red?.props['color']).toBe('error')
  })

  test('with the cache nearly cold and a context of 30 % or more the hint comes, then goes after a turn', async ($, on) => {
    const clock = await boot($, on, world({ usage: usageOf(40, []) }))
    await turnDone($)
    await clock.advance(49 * MINUTE) // 11 minutes left
    expect(await hintNow($)).toBeUndefined()

    await clock.advance(1 * MINUTE) // 10 minutes left
    expect((await hintNow($))?.text).toBe('→ /compact')

    await turnDone($) // the cache is renewed
    expect(await hintNow($)).toBeUndefined()
  })
})

describe('compact button', () => {
  type Ran = { command: string; args: string; fromPlugin: boolean }

  /**
   * Stands for the engine beneath `command.run`: records which command ran and where it came from,
   * and answers like the built-in. `prompt.submit` and `session.compact` are counted too: neither
   * works for a mod in the desktop app (v0.3.7 and v0.3.8 found out live), so the button must not
   * use them.
   */
  function listen(ran: Ran[], other: string[], answer?: () => Promise<{ text: string }>) {
    return (on: On) => {
      on('command.run', async (_$, e) => {
        ran.push({ command: e.command, args: e.args, fromPlugin: e.origin.kind === 'plugin' })
        return answer ? await answer() : { text: 'Compacted' }
      })
      on('prompt.submit', (_$, e) => {
        other.push(`prompt.submit ${e.text}`)
        return { text: e.text }
      })
      on('session.compact', () => {
        other.push('session.compact')
        return { skip: 'test' }
      })
    }
  }

  test('the hint is a button keyed compact, drawn last', async ($, on) => {
    await boot($, on, world({ usage: usageOf(75, []) }))
    const ui = await mountBand($)
    const button = await ui.find({ type: 'Button', key: 'compact' })
    expect(button?.text).toBe('→ /compact')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
    await ui.unmount()
  })

  test('the button is accepted on the terminal and on the desktop surface', async ($, on) => {
    await boot($, on, world({ usage: usageOf(75, []) }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'stavovy-radek',
        surface,
        component: 'AbovePrompt',
        props: BAND,
      })
      expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('no button while no compact is due', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })

  test('a press runs the real compact command and touches neither prompt.submit nor session.compact', async ($, on) => {
    const ran: Ran[] = []
    const other: string[] = []
    await boot($, on, world({ usage: usageOf(75, []) }), listen(ran, other))
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    expect(ran).toEqual([{ command: 'compact', args: '', fromPlugin: true }])
    expect(other).toEqual([])
    await ui.unmount()
  })

  test('after a press the hint is plain text "compactuji…", so a second press cannot queue a second compact', async ($, on) => {
    const ran: Ran[] = []
    await boot($, on, world({ usage: usageOf(75, []) }), listen(ran, []))
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect(await ui.find({ text: /compactuji/ })).toBeDefined()
    expect(ran).toHaveLength(1)
    await ui.unmount()
  })

  test('once the command has returned the hint stays text for 45 more seconds, then the button is back', async ($, on) => {
    const ran: Ran[] = []
    const clock = await boot($, on, world({ usage: usageOf(75, []) }), listen(ran, []))
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    await clock.advance(31 * 1000)
    expect(await ui.find({ text: /compactuji/ })).toBeDefined()
    await clock.advance(30 * 1000)
    expect(await ui.find({ text: /compactuji/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  })

  test('while the command has not returned yet the hint stays text for 15 minutes, then the button is back', async ($, on) => {
    const ran: Ran[] = []
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const clock = await boot(
      $,
      on,
      world({ usage: usageOf(75, []) }),
      listen(ran, [], async () => {
        await gate
        return { text: 'Compacted' }
      }),
    )
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    await clock.advance(14 * 60 * 1000)
    expect(await ui.find({ text: /compactuji/ })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await clock.advance(61 * 1000)
    expect(await ui.find({ text: /compactuji/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    open()
    await ui.unmount()
  })

  test('a press during a turn is queued: the command returning early does not bring the button back', async ($, on) => {
    const ran: Ran[] = []
    const clock = await boot($, on, world({ usage: usageOf(75, []) }), listen(ran, []))
    await turnBegins($)
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    await clock.advance(2 * 60 * 1000)
    expect(await ui.find({ text: /compactuji/ })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })

  test('a press during a turn runs the command at once, the engine queues it behind the turn', async ($, on) => {
    const ran: Ran[] = []
    await boot($, on, world({ usage: usageOf(75, []) }), listen(ran, []))
    await turnBegins($)
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    expect(ran).toEqual([{ command: 'compact', args: '', fromPlugin: true }])
    await ui.unmount()
  })

  test('a refused command leaves the button and the band as they were', async ($, on) => {
    const ran: Ran[] = []
    await boot(
      $,
      on,
      world({ usage: usageOf(75, []) }),
      listen(ran, [], async () => {
        throw new Error('no compact here')
      }),
    )
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    expect(ran).toHaveLength(1)
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    expect(await ui.find({ text: /ctx 75 %/ })).toBeDefined()
    await ui.unmount()
  })

  test('at 20 % of the context there is nothing to press, even while a turn runs', async ($, on) => {
    await boot($, on, world({ usage: usageOf(20, []) }), listen([], []))
    await turnBegins($)
    const ui = await mountBand($)
    expect(await ui.find({ text: /compact/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('compaction in progress (session.compact)', () => {
  const MESSAGES = [{ role: 'user' as const, text: 'hello', toolUses: [] }]
  const COMPACT_INPUT = { trigger: 'manual' as const, messages: MESSAGES }

  /** The engine beneath `session.compact`: holds every compaction until the test opens the gate. */
  function gatedCompact() {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    return { open, engine: (on: On) => on('session.compact', async () => {
      await gate
      return { messages: MESSAGES }
    }) }
  }

  async function hintNow($: Engine) {
    const ui = await mountBand($)
    const text = await ui.find({ text: /compactuji/ })
    const button = await ui.find({ type: 'Button', key: 'compact' })
    await ui.unmount()
    return { isText: text !== undefined, isButton: button !== undefined }
  }

  test('the band says "compactuji…" while any compaction runs, even one nobody pressed a button for', async ($, on) => {
    const { open, engine } = gatedCompact()
    await boot($, on, world({ usage: usageOf(75, []) }), engine)
    expect(await hintNow($)).toEqual({ isText: false, isButton: true })
    const pending = $.session.compact(COMPACT_INPUT)
    expect(await hintNow($)).toEqual({ isText: true, isButton: false })
    open()
    await pending
  })

  test('it is released when the compaction settles, after the short settle window', async ($, on) => {
    const { open, engine } = gatedCompact()
    const clock = await boot($, on, world({ usage: usageOf(75, []) }), engine)
    const pending = $.session.compact(COMPACT_INPUT)
    await clock.advance(5 * 60 * 1000) // a slow compaction: the old 3 minute timer would have run out
    expect(await hintNow($)).toEqual({ isText: true, isButton: false })

    open()
    await pending
    await clock.advance(31 * 1000)
    expect(await hintNow($)).toEqual({ isText: true, isButton: false })
    await clock.advance(30 * 1000)
    expect(await hintNow($)).toEqual({ isText: false, isButton: true })
  })

  test('a compaction that never reports back lets go after 15 minutes', async ($, on) => {
    const { open, engine } = gatedCompact()
    const clock = await boot($, on, world({ usage: usageOf(75, []) }), engine)
    const pending = $.session.compact(COMPACT_INPUT)
    await clock.advance(14 * 60 * 1000)
    expect((await hintNow($)).isText).toBe(true)
    await clock.advance(61 * 1000)
    expect(await hintNow($)).toEqual({ isText: false, isButton: true })
    open()
    await pending
  })

  test('the result of the compaction passes through unchanged', async ($, on) => {
    await boot($, on, world({ usage: usageOf(75, []) }), (o) => {
      o('session.compact', () => ({ messages: MESSAGES, tokensBefore: 123, tokensAfter: 45 }))
    })
    const result = await $.session.compact(COMPACT_INPUT)
    expect(result).toEqual({ messages: MESSAGES, tokensBefore: 123, tokensAfter: 45 })
  })

  test('a skipped compaction passes through as well', async ($, on) => {
    await boot($, on, world({ usage: usageOf(75, []) }), (o) => {
      o('session.compact', () => ({ skip: 'nothing to compact' }))
    })
    expect(await $.session.compact(COMPACT_INPUT)).toEqual({ skip: 'nothing to compact' })
  })

  test('a precompute and a subagent\'s own compaction do not show on the band', async ($, on) => {
    const { open, engine } = gatedCompact()
    await boot($, on, world({ usage: usageOf(75, []) }), engine)
    const precompute = $.session.compact({ trigger: 'precompute', messages: MESSAGES })
    expect(await hintNow($)).toEqual({ isText: false, isButton: true })
    const subagent = $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'helper' })
    expect(await hintNow($)).toEqual({ isText: false, isButton: true })
    open()
    await precompute
    await subagent
  })

  test('the engine\'s own threshold compaction shows too', async ($, on) => {
    const { open, engine } = gatedCompact()
    await boot($, on, world({ usage: usageOf(75, []) }), engine)
    const pending = $.session.compact({ trigger: 'auto', messages: MESSAGES })
    expect((await hintNow($)).isText).toBe(true)
    open()
    await pending
  })

  test('two compactions at once: the hold ends after the last one', async ($, on) => {
    const { open, engine } = gatedCompact()
    const clock = await boot($, on, world({ usage: usageOf(75, []) }), engine)
    const first = $.session.compact(COMPACT_INPUT)
    const second = $.session.compact({ trigger: 'auto', messages: MESSAGES })
    open()
    await first
    await second
    await clock.advance(31 * 1000)
    expect((await hintNow($)).isText).toBe(true)
    await clock.advance(30 * 1000)
    expect((await hintNow($)).isButton).toBe(true)
  })
})

describe('safeguard before the cache runs out', () => {
  type Seen = {
    submits: { text: string; fromPlugin: boolean }[]
    ran: string[]
    other: string[]
  }
  type Written = { path: string; text: string }
  type Reason = 'answer' | 'aborted' | 'error' | 'refusal'

  const newSeen = (): Seen => ({ submits: [], ran: [], other: [] })

  const FLUSH = { options: { guard: 'flush-then-compact' } }
  const COMPACT = { options: { guard: 'compact' } }

  /**
   * Stands for the engine beneath the calls the safeguard makes: the prompt it submits and the
   * `/compact` it runs. `session.compact` is counted too: the desktop app refuses it for a mod.
   */
  function engineBeneath(seen: Seen, options: { refusePrompt?: boolean } = {}) {
    return (on: On): void => {
      on('prompt.submit', (_$, e) => {
        // Only what this mod submitted is recorded: the person's prompts the tests raise are not its own.
        const isOwn = e.origin?.kind === 'plugin' && e.origin.name === 'stavovy-radek'
        if (isOwn) seen.submits.push({ text: e.text, fromPlugin: true })
        if (isOwn && options.refusePrompt === true) throw new Error('no prompts here')
        return { text: e.text }
      })
      on('command.run', (_$, e) => {
        seen.ran.push(e.command)
        return { text: 'Compacted' }
      })
      on('session.compact', () => {
        seen.other.push('session.compact')
        return { skip: 'test' }
      })
    }
  }

  /** The diagnostic file switched on for session `sess-1`, collected into `writes`. */
  function diagnostics(writes: Written[]) {
    return (on: On): void => {
      on('session.id', () => ({ value: 'sess-1' }))
      on('fs.exists', (_$, e) => {
        const path = e.path.replace(/\\/g, '/')
        return {
          value:
            path.endsWith('_local/stavovy-radek') || path.endsWith('_local/stavovy-radek/diag-sess-1.on'),
        }
      })
      on('fs.write', (_$, e) => {
        writes.push({ path: e.path, text: e.text })
        return { value: undefined }
      })
    }
  }

  function lastDiag(writes: Written[]): Record<string, unknown> {
    return JSON.parse(writes[writes.length - 1]?.text ?? '{}') as Record<string, unknown>
  }

  /** A window the app reports at 40 % of the context, after one finished turn. */
  async function idleWindow(
    $: Engine,
    on: On,
    seen: Seen,
    options: { refusePrompt?: boolean; writes?: Written[] } = {},
  ) {
    const clock = await boot($, on, world({ app: appUsage({ contextPercent: 40 }) }), (o) => {
      engineBeneath(seen, options)(o)
      if (options.writes !== undefined) diagnostics(options.writes)(o)
    })
    await turnDone($)
    return clock
  }

  async function passMinutes(clock: Awaited<ReturnType<typeof boot>>, minutes: number) {
    await clock.advance(minutes * MINUTE)
    await clock.settle()
  }

  async function flushTurn($: Engine, turnId: string, reason: Reason = 'answer') {
    await $.turn.start({ text: 'compact', turnId })
    const base = { answer: 'flush hotov', durationMs: 5, isAborted: reason === 'aborted', turnId }
    if (reason === 'refusal') {
      return $.turn.complete({ ...base, reason, refusal: { category: null, explanation: null } })
    }
    return $.turn.complete({ ...base, reason })
  }

  /** The person's own prompt, as the composer raises it. */
  function personSubmits($: Engine, text: string = 'hello again') {
    return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  }

  /** A whole turn the person started (the prompt, the turn, its end). */
  async function personTurn($: Engine, turnId: string, text: string = 'hello again') {
    await personSubmits($, text)
    await $.turn.start({ text, turnId })
    await $.turn.complete({ answer: 'hi', durationMs: 5, isAborted: false, turnId, reason: 'answer' })
  }

  describe('off (the default)', () => {
    test('nothing is ever sent or run, however long the window sits idle', async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 59)
      await passMinutes(clock, 120)
      expect(seen.submits).toEqual([])
      expect(seen.ran).toEqual([])
      expect(seen.other).toEqual([])
    })

    test('an explicit "off" is the same', { options: { guard: 'off' } }, async ($, on) => {
      const seen = newSeen()
      const clock = await boot($, on, world({ app: appUsage({ contextPercent: 40 }) }), engineBeneath(seen))
      await turnDone($)
      await passMinutes(clock, 55)
      expect(seen.submits).toEqual([])
      expect(seen.ran).toEqual([])
    })

    test('a value outside the choices counts as unset: still off', { options: { guard: 'always' } }, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 55)
      expect(seen.ran).toEqual([])
    })
  })

  describe('flush-then-compact', () => {
    test('sends nothing until the cache is down to 10 minutes, then sends the flush text once', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 49)
      expect(seen.submits).toEqual([])
      await passMinutes(clock, 1)
      expect(seen.submits).toEqual([{ text: 'compact', fromPlugin: true }])
      await passMinutes(clock, 5)
      expect(seen.submits).toHaveLength(1)
      expect(seen.ran).toEqual([])
      expect(seen.other).toEqual([])
    })

    test('compacts for real once the flush turn has ended with an answer, and not before', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await $.turn.start({ text: 'compact', turnId: 'f1' })
      await passMinutes(clock, 2)
      expect(seen.ran).toEqual([])
      await $.turn.complete({
        answer: 'flush hotov',
        durationMs: 5,
        isAborted: false,
        turnId: 'f1',
        reason: 'answer',
      })
      await clock.settle()
      expect(seen.ran).toEqual(['compact'])
      expect(seen.other).toEqual([])
      await passMinutes(clock, 5)
      expect(seen.ran).toEqual(['compact'])
      expect(seen.submits).toHaveLength(1)
    })

    test('a flush turn the person interrupts compacts nothing', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await flushTurn($, 'f1', 'aborted')
      await clock.settle()
      expect(seen.ran).toEqual([])
    })

    for (const reason of ['error', 'refusal'] as const) {
      test(`a flush turn that ends in ${reason} compacts nothing and says why`, FLUSH, async ($, on) => {
        const seen = newSeen()
        const writes: Written[] = []
        const clock = await idleWindow($, on, seen, { writes })
        await passMinutes(clock, 50)
        await flushTurn($, 'f1', reason)
        await clock.settle()
        expect(seen.ran).toEqual([])
        await passMinutes(clock, 1)
        expect(lastDiag(writes)['guardLastResult']).toBe(`flush turn ended: ${reason}, no compact`)
        expect(lastDiag(writes)['guardPhase']).toBe('idle')
        // and it does not try again on its own
        await passMinutes(clock, 120)
        expect(seen.ran).toEqual([])
        expect(seen.submits).toHaveLength(1)
      })
    }

    test('an interrupted flush turn is recorded as such', FLUSH, async ($, on) => {
      const seen = newSeen()
      const writes: Written[] = []
      const clock = await idleWindow($, on, seen, { writes })
      await passMinutes(clock, 50)
      await flushTurn($, 'f1', 'aborted')
      await passMinutes(clock, 1)
      expect(lastDiag(writes)['guardLastResult']).toBe('flush turn ended: aborted, no compact')
    })

    test('when the person comes back first, the safeguard stands down and the late flush turn compacts nothing', FLUSH, async ($, on) => {
      const seen = newSeen()
      const writes: Written[] = []
      const clock = await idleWindow($, on, seen, { writes })
      await passMinutes(clock, 50)
      await personTurn($, 'u1', 'what is the weather')
      await flushTurn($, 'f1')
      await clock.settle()
      expect(seen.ran).toEqual([])
      await passMinutes(clock, 1)
      expect(lastDiag(writes)['guardLastResult']).toBe('stood down: the person came back before the flush turn')
    })

    test('the person writing while the flush turn runs cancels the compact', FLUSH, async ($, on) => {
      const seen = newSeen()
      const writes: Written[] = []
      const clock = await idleWindow($, on, seen, { writes })
      await passMinutes(clock, 50)
      await $.turn.start({ text: 'compact', turnId: 'f1' })
      await personSubmits($, 'wait, one more thing')
      await $.turn.complete({
        answer: 'flush hotov',
        durationMs: 5,
        isAborted: false,
        turnId: 'f1',
        reason: 'answer',
      })
      await clock.settle()
      expect(seen.ran).toEqual([])
      await passMinutes(clock, 1)
      expect(lastDiag(writes)['guardLastResult']).toBe('user returned during flush: no compact')
      expect(lastDiag(writes)['guardPhase']).toBe('idle')
    })

    test('a prompt of another session, a notification or a plugin during the flush turn does not cancel it', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await $.turn.start({ text: 'compact', turnId: 'f1' })
      for (const kind of ['peer', 'task-notification', 'scheduled-trigger', 'peer-send-message'] as const) {
        await $.prompt.submit({ text: `from ${kind}`, origin: { kind }, wait: false })
      }
      await $.prompt.submit({
        text: 'from a plugin',
        origin: { kind: 'plugin', name: 'other-mod', asUser: true },
        wait: false,
      })
      await $.prompt.submit({ text: 'unseen', origin: { kind: 'composer' }, isMeta: true, wait: false })
      await $.turn.complete({
        answer: 'flush hotov',
        durationMs: 5,
        isAborted: false,
        turnId: 'f1',
        reason: 'answer',
      })
      await clock.settle()
      expect(seen.ran).toEqual(['compact'])
    })

    test('a subagent saying the same word is not the flush turn', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await $.turn.start({ text: 'compact', turnId: 'sub1', agentId: 'helper' })
      await $.turn.complete({
        answer: 'done',
        durationMs: 5,
        isAborted: false,
        turnId: 'sub1',
        agentId: 'helper',
        reason: 'answer',
      })
      await clock.settle()
      expect(seen.ran).toEqual([])
    })

    test('after a full go it stays quiet for hours, and arms again only when the person writes', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await flushTurn($, 'f1')
      await clock.settle()
      expect(seen.ran).toEqual(['compact'])
      // Nobody comes back: the next idle hour (context still 40 %) starts nothing.
      await passMinutes(clock, 120)
      expect(seen.submits).toHaveLength(1)
      expect(seen.ran).toEqual(['compact'])
      // The person writes a prompt of their own; the next idle hour is guarded again.
      await personTurn($, 'u1')
      await passMinutes(clock, 50)
      expect(seen.submits).toHaveLength(2)
    })

    test('turns that are not the person\'s do not arm it again: wake-ups, other sessions, notifications, its own flush text', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await flushTurn($, 'f1')
      await clock.settle()
      expect(seen.submits).toHaveLength(1)

      // Turns with text but no prompt of the person's: a wake-up, a peer's message, a notification.
      for (const kind of ['peer', 'task-notification', 'scheduled-trigger', 'peer-send-message', 'channel'] as const) {
        const origin = kind === 'channel' ? { kind, server: 'chat' } : { kind }
        await $.prompt.submit({ text: `from ${kind}`, origin, wait: false })
        await $.turn.start({ text: `from ${kind}`, turnId: `n-${kind}` })
        await $.turn.complete({
          answer: 'ok',
          durationMs: 5,
          isAborted: false,
          turnId: `n-${kind}`,
          reason: 'answer',
        })
      }
      await $.prompt.submit({
        text: 'from a plugin',
        origin: { kind: 'plugin', name: 'other-mod', asUser: true },
        wait: false,
      })
      // A turn that started with text and no prompt at all (a continuation, a wake-up).
      await $.turn.start({ text: 'woken up', turnId: 'w1' })
      await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'w1', reason: 'answer' })

      await passMinutes(clock, 50)
      expect(seen.submits).toHaveLength(1)
      expect(seen.ran).toEqual(['compact'])
    })

    for (const kind of ['composer', 'bridge', 'unclassified'] as const) {
      test(`a prompt of kind ${kind} arms it again`, FLUSH, async ($, on) => {
        const seen = newSeen()
        const clock = await idleWindow($, on, seen)
        await passMinutes(clock, 50)
        await flushTurn($, 'f1')
        await clock.settle()
        await passMinutes(clock, 60)
        expect(seen.submits).toHaveLength(1)
        await $.prompt.submit({ text: 'back', origin: { kind }, wait: false })
        await $.turn.start({ text: 'back', turnId: 'u1' })
        await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'u1', reason: 'answer' })
        await passMinutes(clock, 50)
        expect(seen.submits).toHaveLength(2)
      })
    }

    test('a flush turn that never ends is given up on after 20 minutes: no compact, no second word', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await passMinutes(clock, 25)
      expect(seen.submits).toHaveLength(1)
      expect(seen.ran).toEqual([])
    })

    test('a refused word is not sent again on every tick', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen, { refusePrompt: true })
      await passMinutes(clock, 50)
      expect(seen.submits).toHaveLength(1)
      await passMinutes(clock, 6)
      expect(seen.submits).toHaveLength(1)
      expect(seen.ran).toEqual([])
    })

    test('the flush text is the option; only a turn carrying exactly it is the flush turn', { options: { guard: 'flush-then-compact', flushText: 'save notes' } }, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      expect(seen.submits).toEqual([{ text: 'save notes', fromPlugin: true }])
      await $.turn.start({ text: 'compact', turnId: 'x1' })
      await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'x1', reason: 'answer' })
      await clock.settle()
      expect(seen.ran).toEqual([])
      await $.turn.start({ text: 'Save notes', turnId: 'f1' })
      await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'f1', reason: 'answer' })
      await clock.settle()
      expect(seen.ran).toEqual(['compact'])
    })

    test('nothing below 30 % of the context', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await boot($, on, world({ app: appUsage({ contextPercent: 25 }) }), engineBeneath(seen))
      await turnDone($)
      await passMinutes(clock, 55)
      expect(seen.submits).toEqual([])
    })

    test('nothing while a turn runs, however long it lasts', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await turnBegins($)
      await passMinutes(clock, 55)
      expect(seen.submits).toEqual([])
    })

    test('nothing when the figures are not the desktop app\'s (a -p run, a CLI window)', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await boot($, on, world({ app: null, usage: usageOf(40, []) }), engineBeneath(seen))
      await turnDone($)
      await passMinutes(clock, 55)
      expect(seen.submits).toEqual([])
    })

    test('nothing for a window whose last activity is unknown (met mid-idle)', FLUSH, async ($, on) => {
      const seen = newSeen()
      const clock = await boot($, on, world({ app: appUsage({ contextPercent: 40 }) }), engineBeneath(seen))
      await passMinutes(clock, 55)
      expect(seen.submits).toEqual([])
    })

    test('the diagnostic file says where the safeguard stands', FLUSH, async ($, on) => {
      const seen = newSeen()
      const writes: Written[] = []
      const clock = await idleWindow($, on, seen, { writes })
      await passMinutes(clock, 50)
      const diag = lastDiag(writes)
      expect(diag['guardPhase']).toBe('flushing')
      expect(diag['guardAttempts']).toBe(1)
      expect(diag['guardLastResult']).toBe('flush word sent')
      expect(diag['guardMode']).toBe('flush-then-compact')
      expect(diag['cacheTtlMinutes']).toBe(60)
    })
  })

  describe('compact', () => {
    test('runs the real compact once the cache is down to 10 minutes, with no flush word', COMPACT, async ($, on) => {
      const seen = newSeen()
      const writes: Written[] = []
      const clock = await idleWindow($, on, seen, { writes })
      await passMinutes(clock, 49)
      expect(seen.ran).toEqual([])
      await passMinutes(clock, 1)
      expect(seen.ran).toEqual(['compact'])
      expect(seen.submits).toEqual([])
      expect(seen.other).toEqual([])
      expect(lastDiag(writes)['guardLastResult']).toBe('compact requested')
      expect(lastDiag(writes)['guardPhase']).toBe('idle')
    })

    test('once, not every hour: it arms again only when the person writes', COMPACT, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      expect(seen.ran).toEqual(['compact'])
      await passMinutes(clock, 180)
      expect(seen.ran).toEqual(['compact'])
      await personTurn($, 'u1')
      await passMinutes(clock, 50)
      expect(seen.ran).toEqual(['compact', 'compact'])
      expect(seen.submits).toEqual([])
    })

    test('a turn with text but no prompt of the person\'s does not arm it', COMPACT, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 50)
      await $.turn.start({ text: 'woken up', turnId: 'w1' })
      await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'w1', reason: 'answer' })
      await passMinutes(clock, 50)
      expect(seen.ran).toEqual(['compact'])
    })

    test('the same conditions as the flush mode: not below 30 %, not during a turn', COMPACT, async ($, on) => {
      const seen = newSeen()
      const clock = await boot($, on, world({ app: appUsage({ contextPercent: 25 }) }), engineBeneath(seen))
      await turnDone($)
      await passMinutes(clock, 55)
      expect(seen.ran).toEqual([])
    })

    test('nothing while a turn runs', COMPACT, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await turnBegins($)
      await passMinutes(clock, 55)
      expect(seen.ran).toEqual([])
    })
  })

  describe('cache lifetime option', () => {
    test('30 minutes: acts at 5 minutes left (a third of the hour scaled down)', { options: { guard: 'compact', cacheTtlMinutes: 30 } }, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 24)
      expect(seen.ran).toEqual([])
      await passMinutes(clock, 1)
      expect(seen.ran).toEqual(['compact'])
    })

    test('120 minutes: acts at 20 minutes left', { options: { guard: 'compact', cacheTtlMinutes: 120 } }, async ($, on) => {
      const seen = newSeen()
      const clock = await idleWindow($, on, seen)
      await passMinutes(clock, 99)
      expect(seen.ran).toEqual([])
      await passMinutes(clock, 1)
      expect(seen.ran).toEqual(['compact'])
    })

    for (const guard of ['compact', 'flush-then-compact']) {
      for (const cacheTtlMinutes of [5, 29]) {
        test(`${guard} never acts when the cache lives only ${cacheTtlMinutes} minutes`, { options: { guard, cacheTtlMinutes } }, async ($, on) => {
          const seen = newSeen()
          const writes: Written[] = []
          const clock = await idleWindow($, on, seen, { writes })
          await passMinutes(clock, cacheTtlMinutes + 5)
          await passMinutes(clock, 120)
          expect(seen.submits).toEqual([])
          expect(seen.ran).toEqual([])
          expect(lastDiag(writes)['guardMode']).toBe('off')
        })
      }
    }

    test('the band counts down from 5 minutes with the scaled colours', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
      const clock = await boot($, on, world({ usage: usageOf(18, []) }))
      await turnDone($)
      const shown = async () => {
        const ui = await mountBand($)
        const segment = await leaf(ui, /cache/)
        await ui.unmount()
        return segment
      }
      expect((await shown())?.text).toBe('cache 5 min')
      expect((await shown())?.props['color']).toBe('success')
      await clock.advance(3 * MINUTE)
      expect((await shown())?.text).toBe('cache 2 min')
      expect((await shown())?.props['color']).toBe('warning')
      await clock.advance(1 * MINUTE)
      expect((await shown())?.props['color']).toBe('error')
      await clock.advance(1 * MINUTE)
      expect((await shown())?.text).toBe('cache studená')
    })
  })

  describe('the prompt.submit hook', () => {
    test('passes the prompt on unchanged and returns what the engine returned', async ($, on) => {
      await boot($, on, world(), (o) => {
        o('prompt.submit', (_$, e) => ({ text: `${e.text}!`, context: ['note'] }))
      })
      const result = await personSubmits($, 'hello')
      expect(result).toEqual({ text: 'hello!', context: ['note'] })
    })

    test('lets a prompt without an origin through as well', async ($, on) => {
      await boot($, on, world(), (o) => {
        o('prompt.submit', (_$, e) => ({ text: e.text }))
      })
      const bare = { text: 'hello', wait: false } as unknown as Parameters<Engine['prompt']['submit']>[0]
      expect(await $.prompt.submit(bare)).toEqual({ text: 'hello' })
    })

    test('a drop by the engine below it is returned as it is', async ($, on) => {
      await boot($, on, world(), (o) => {
        o('prompt.submit', () => ({ drop: 'not now' }))
      })
      expect(await personSubmits($, 'hello')).toEqual({ drop: 'not now' })
    })
  })
})

describe('project and worktree', () => {
  test('a GitHub remote makes the project name a link', async ($, on) => {
    await boot($, on, world())
    const ui = await mountBand($)
    const link = await ui.find({ type: 'Link' })
    expect(link?.props['href']).toBe('https://github.com/acme/demo')
    expect(link?.text).toBe('demo')
    await ui.unmount()
  })

  test('another host or no remote leaves the project as plain text', async ($, on) => {
    await boot($, on, world({ remote: 'https://gitlab.com/acme/demo.git' }))
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect((await leaf(ui, /^demo$/))?.type).toBe('Text')
    await ui.unmount()
  })

  test('.git as a file means a worktree', async ($, on) => {
    await boot($, on, world({ gitKind: 'file' }))
    const ui = await mountBand($)
    expect((await leaf(ui, /wt demo/))?.text).toBe('wt demo')
    await ui.unmount()
  })

  test('.git as a folder, or no .git at all, is not a worktree (re-read on every 4th tick)', async ($, on) => {
    const w = world({ gitKind: 'file' })
    const clock = await boot($, on, w)
    const shows = async () => {
      const ui = await mountBand($)
      const segment = await ui.find({ text: /wt / })
      await ui.unmount()
      return segment !== undefined
    }
    expect(await shows()).toBe(true)

    w.gitKind = 'dir'
    await clock.advance(30 * 1000)
    expect(await shows()).toBe(true) // the fast tick does not look again
    await clock.advance(90 * 1000) // the 4th tick
    expect(await shows()).toBe(false)

    w.gitKind = 'file'
    await clock.advance(2 * 60 * 1000)
    expect(await shows()).toBe(true)

    w.gitKind = null // the stat is refused: not a worktree
    await clock.advance(2 * 60 * 1000)
    expect(await shows()).toBe(false)
  })

  test('only the derived GitHub link is kept, never the raw remote', async ($, on) => {
    const writes: { path: string; text: string }[] = []
    const secret = 'https://user:token123@github.com/acme/demo.git'
    await boot($, on, world({ remote: secret }), (o) => {
      o('session.id', () => ({ value: 'sess-1' }))
      o('fs.exists', () => ({ value: true }))
      o('fs.write', (_$, e) => {
        writes.push({ path: e.path, text: e.text })
        return { value: undefined }
      })
    })
    // a remote with credentials does not make a link, and nothing of it reaches the file
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every((w) => !w.text.includes('token123') && !w.text.includes('user:'))).toBe(true)
  })

  test('what is written to the state is the GitHub URL, or nothing', async ($, on) => {
    const sets: unknown[] = []
    await boot($, on, world(), (o) => {
      o('state.set', (_$, e, next) => {
        if (e.key === 'remote') sets.push(e.value)
        return next(e)
      })
    })
    expect(sets).toEqual(['https://github.com/acme/demo'])
  })

  test('a non-GitHub remote writes nothing to the state', async ($, on) => {
    const sets: unknown[] = []
    await boot($, on, world({ remote: 'https://gitlab.com/acme/demo.git' }), (o) => {
      o('state.set', (_$, e, next) => {
        if (e.key === 'remote') sets.push(e.value)
        return next(e)
      })
    })
    expect(sets.every((v) => v === null)).toBe(true)
  })

  test('a raw remote left in the state by version 0.4.0 is replaced at the start, not kept', async ($, on) => {
    const legacy = 'https://user:token123@github.com/acme/demo.git'
    const sets: unknown[] = []
    await boot($, on, world({ remote: null }), (o) => {
      o('state.get', (_$, e, next) => (e.key === 'remote' ? { value: { value: legacy, version: 1 } } : next(e)))
      o('state.set', (_$, e, next) => {
        if (e.key === 'remote') sets.push(e.value)
        return next(e)
      })
    })
    expect(sets[0]).toBeNull()
    expect(sets.some((v) => typeof v === 'string' && v.includes('token123'))).toBe(false)
    // and the band never draws it as a link
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test('a legacy GitHub remote with SSH form is turned into the URL', async ($, on) => {
    const sets: unknown[] = []
    await boot($, on, world({ remote: null }), (o) => {
      o('state.get', (_$, e, next) => (e.key === 'remote' ? { value: { value: 'git@github.com:acme/demo.git', version: 1 } } : next(e)))
      o('state.set', (_$, e, next) => {
        if (e.key === 'remote') sets.push(e.value)
        return next(e)
      })
    })
    expect(sets[0]).toBe('https://github.com/acme/demo')
  })
})

describe('slow and fast ticks', () => {
  test('the project, the model and .git are read at the start and on every 4th tick, not on each tick', async ($, on) => {
    const w = world({ app: appUsage() })
    const clock = await boot($, on, w)
    const total = () => w.reads.model + w.reads.root + w.reads.repo + w.reads.stat
    expect(w.reads).toEqual({ model: 1, root: 1, repo: 1, stat: 1 })
    expect(w.appCalls.length).toBe(1)

    await clock.advance(90 * 1000) // ticks 1 to 3: the fast ones
    expect(total()).toBe(4)
    await clock.advance(30 * 1000) // tick 4
    expect(w.reads).toEqual({ model: 2, root: 2, repo: 2, stat: 2 })
    await clock.advance(90 * 1000) // ticks 5 to 7
    expect(total()).toBe(8)
    await clock.advance(30 * 1000) // tick 8
    expect(w.reads).toEqual({ model: 3, root: 3, repo: 3, stat: 3 })
  })

  test('the fast tick still moves the clock: the cache countdown goes on', async ($, on) => {
    const w = world({ usage: usageOf(18, []) })
    const clock = await boot($, on, w)
    await turnDone($)
    await clock.advance(30 * 1000)
    const ui = await mountBand($)
    expect((await leaf(ui, /cache/))?.text).toBe('cache 60 min')
    await clock.advance(30 * 1000 + 29 * MINUTE)
    expect((await leaf(ui, /cache/))?.text).toBe('cache 30 min')
    await ui.unmount()
  })

  test('the diagnostic file is still rewritten on the fast tick', async ($, on) => {
    const writes: { path: string; text: string }[] = []
    const clock = await boot($, on, world({ usage: usageOf(18, []) }), (o) => {
      o('session.id', () => ({ value: 'sess-1' }))
      o('fs.exists', (_$, e) => {
        const path = e.path.split('\\').join('/')
        return {
          value:
            path.endsWith('_local/stavovy-radek') || path.endsWith('_local/stavovy-radek/diag-sess-1.on'),
        }
      })
      o('fs.write', (_$, e) => {
        writes.push({ path: e.path, text: e.text })
        return { value: undefined }
      })
    })
    const before = writes.length
    await clock.advance(30 * 1000)
    expect(writes.length).toBe(before + 1)
  })
})

describe('language option', () => {
  test('English labels on the band', { options: { language: 'en' } }, async ($, on) => {
    const clock = await boot($, on, world({ app: appUsage({ fable: 12 }) }))
    await turnBegins($)
    const ui = await mountBand($)
    expect((await leaf(ui, /week/))?.text).toBe('week 22 %↑ · 5d 11h')
    expect((await leaf(ui, /Fable/))?.text).toBe('Fable wk 12 %')
    expect((await leaf(ui, /cache/))?.text).toBe('cache 60 min · turn running')
    expect(await ui.find({ text: /týden/ })).toBeUndefined()
    await ui.unmount()
    await clock.advance(61 * MINUTE)
    const cold = await mountBand($)
    expect((await leaf(cold, /cache/))?.text).toBe('cache cold · turn running')
    await cold.unmount()
  })

  test('Czech is the default', async ($, on) => {
    await boot($, on, world({ app: appUsage() }))
    await turnBegins($)
    const ui = await mountBand($)
    expect((await leaf(ui, /týden/))?.text).toBe('týden 22 %↑ · 5d 11h')
    expect((await leaf(ui, /cache/))?.text).toBe('cache 60 min · tah běží')
    await ui.unmount()
  })

  test('the compact hint says "compacting…" in English after a press', { options: { language: 'en' } }, async ($, on) => {
    await boot($, on, world({ usage: usageOf(75, []) }), (o) => {
      o('command.run', () => ({ text: 'Compacted' }))
    })
    const ui = await mountBand($)
    await ui.press({ key: 'compact' })
    expect(await ui.find({ text: /compacting…/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('refresh', () => {
  test('a slow tick (every 4th) picks up a changed model', async ($, on) => {
    const w = world()
    const clock = await boot($, on, w)
    w.model = 'claude-other-model'
    await clock.advance(30 * 1000)
    const early = await mountBand($)
    expect(await leaf(early, /test-model/)).toBeDefined()
    await early.unmount()
    await clock.advance(90 * 1000)
    const ui = await mountBand($)
    expect(await leaf(ui, /other-model/)).toBeDefined()
    expect(await ui.find({ text: /test-model/ })).toBeUndefined()
    await ui.unmount()
  })

  test('failed reads keep the previous values and the band still draws', async ($, on) => {
    const w = world()
    const clock = await boot($, on, w)
    w.usage = null
    await clock.advance(30 * 1000)
    const ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 18 %')
    expect(await leaf(ui, /5h 41 %/)).toBeDefined()
    await ui.unmount()
  })
})

describe('numbers from the app', () => {
  test('weekly limit and context come from the app, the engine figures stay out', async ($, on) => {
    const w = world({ app: appUsage() })
    await boot($, on, w)
    const ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 77 %')
    expect((await leaf(ui, /týden/))?.text).toBe('týden 22 %↑ · 5d 11h')
    // the engine's 5 h window (and its ctx 18 %) are not shown while the app's reading is fresh
    expect(await ui.find({ text: /5h/ })).toBeUndefined()
    expect(await ui.find({ text: /ctx 18 %/ })).toBeUndefined()
    // a model window with nothing used has no segment
    expect(await ui.find({ text: /Fable/ })).toBeUndefined()
    await ui.unmount()
    expect(w.appCalls[0]).toEqual({ server: 'ccd_session_mgmt', tool: 'get_usage' })
  })

  test('a model window shows once something is used', async ($, on) => {
    await boot($, on, world({ app: appUsage({ fable: 12 }) }))
    const ui = await mountBand($)
    expect((await leaf(ui, /Fable/))?.text).toBe('Fable týd. 12 %')
    expect((await leaf(ui, /týden/))?.text).toBe('týden 22 %↑ · 5d 11h')
    await ui.unmount()
  })

  test('the context colour follows the app figure', async ($, on) => {
    await boot($, on, world({ app: appUsage({ contextPercent: 92 }) }))
    const ui = await mountBand($)
    const segment = await leaf(ui, /ctx/)
    expect(segment?.text).toBe('ctx 92 %')
    expect(segment?.props['color']).toBe('error')
    await ui.unmount()
  })

  const failures: { name: string; app: McpToolResult | null }[] = [
    { name: 'the call is refused', app: null },
    { name: 'the tool reports an error', app: { content: [{ type: 'text', text: 'boom' }], isError: true } },
    { name: 'the reply is not JSON', app: { content: [{ type: 'text', text: 'not json' }], isError: false } },
    { name: 'the reply has no text block', app: { content: [], isError: false } },
    { name: 'the plan is unavailable and the context too', app: {
      content: [{ type: 'text', text: JSON.stringify({ plan: { status: 'unavailable' }, context: { status: 'unavailable' } }) }],
      isError: false,
    } },
  ]
  for (const failure of failures) {
    test(`${failure.name}: the engine figures stay and the band still draws`, async ($, on) => {
      const w = world({ app: failure.app })
      await boot($, on, w)
      const ui = await mountBand($)
      expect((await leaf(ui, /ctx/))?.text).toBe('ctx 18 %')
      expect((await leaf(ui, /5h 41 %/))?.text).toBe('5h 41 %↑ · 3h 0m')
      expect(await ui.find({ text: /týden/ })).toBeUndefined()
      expect(await leaf(ui, /test-model/)).toBeDefined()
      await ui.unmount()
      expect(w.appCalls.length).toBe(1)
    })
  }

  test('a fresh app reading is not overwritten by the engine (session.measure)', async ($, on) => {
    await boot($, on, world({ app: appUsage() }))
    await $.session.measure({
      context: { window: 1000000, tokens: 310000, percent: 31 },
      rateLimits: AHEAD,
      changed: ['context', 'rateLimits'],
    })
    const ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 77 %')
    expect(await ui.find({ text: /5h/ })).toBeUndefined()
    expect((await leaf(ui, /týden/))?.text).toBe('týden 22 %↑ · 5d 11h')
    await ui.unmount()
  })

  test('after 5 minutes without a reading the engine figures take over again', async ($, on) => {
    const w = world({ app: appUsage() })
    const clock = await boot($, on, w)
    w.app = null // the app stops answering

    await clock.advance(4 * MINUTE)
    let ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 77 %')
    await ui.unmount()

    await clock.advance(90 * 1000) // 5 min 30 s after the last good reading
    ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 18 %')
    // the engine's window again (5.5 min later: 2 h 55 m left, 41 % is now level with the clock)
    expect((await leaf(ui, /5h 41 %/))?.text).toBe('5h 41 % · 2h 55m')
    expect(await ui.find({ text: /týden/ })).toBeUndefined()
    await ui.unmount()
  })

  test('limits and context are judged separately: a context-only reading leaves the engine limits', async ($, on) => {
    const app = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            plan: { status: 'unavailable' },
            context: { status: 'ok', percentUsed: 64 },
          }),
        },
      ],
      isError: false,
    }
    await boot($, on, world({ app }))
    const ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 64 %')
    expect((await leaf(ui, /5h 41 %/))?.text).toBe('5h 41 %↑ · 3h 0m')
    await ui.unmount()
  })

  test('asked at the start, then on every 4th tick, and after each main-loop turn', async ($, on) => {
    const w = world({ app: appUsage() })
    const clock = await boot($, on, w)
    expect(w.appCalls.length).toBe(1)

    await clock.advance(90 * 1000) // ticks 1 to 3
    expect(w.appCalls.length).toBe(1)
    await clock.advance(30 * 1000) // tick 4 (2 min)
    expect(w.appCalls.length).toBe(2)
    await clock.advance(3 * 30 * 1000) // ticks 5 to 7
    expect(w.appCalls.length).toBe(2)
    await clock.advance(30 * 1000) // tick 8 (4 min)
    expect(w.appCalls.length).toBe(3)

    await turnDone($)
    await clock.settle()
    expect(w.appCalls.length).toBe(4)

    // a subagent turn is not a turn of the window
    await turnDone($, 'agent-1')
    await clock.settle()
    expect(w.appCalls.length).toBe(4)
  })

  test('a turn brings the app\'s newer figures at once', async ($, on) => {
    const w = world({ app: appUsage({ contextPercent: 40 }) })
    const clock = await boot($, on, w)
    w.app = appUsage({ contextPercent: 83 })
    await turnDone($)
    await clock.settle()
    const ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 83 %')
    await ui.unmount()
  })

  test('a turn while the app does not answer breaks nothing', async ($, on) => {
    const w = world({ app: appUsage() })
    const clock = await boot($, on, w)
    w.app = null
    await turnDone($)
    await clock.settle()
    const ui = await mountBand($)
    expect((await leaf(ui, /ctx/))?.text).toBe('ctx 77 %')
    expect((await leaf(ui, /týden/))?.text).toBe('týden 22 %↑ · 5d 11h')
    await ui.unmount()
  })
})

describe('diagnostic file', () => {
  type Written = { path: string; text: string }

  const slashed = (path: string): string => path.replace(/\\/g, '/')

  /**
   * Makes the diagnostic folder exist and collects what the mod writes into it. `marker` is the
   * name of the file asking for diagnostics that exists in that folder (v0.3.5: one per session).
   */
  function diagnostics(writes: Written[], marker: string | null = 'diag-sess-1.on') {
    return (on: On): void => {
      on('session.id', () => ({ value: 'sess-1' }))
      // The engine hands the hook the path resolved against the working folder: match its end.
      on('fs.exists', (_$, e) => {
        const path = slashed(e.path)
        return {
          value:
            path.endsWith('_local/stavovy-radek') ||
            (marker !== null && path.endsWith(`_local/stavovy-radek/${marker}`)),
        }
      })
      on('fs.write', (_$, e) => {
        writes.push({ path: e.path, text: e.text })
        return { value: undefined }
      })
    }
  }

  function lastWrite(writes: Written[]): Record<string, unknown> {
    const last = writes[writes.length - 1]
    expect(last).toBeDefined()
    return JSON.parse(last?.text ?? '{}') as Record<string, unknown>
  }

  test('with the app answering: source app, windows, context, remote only as a flag', async ($, on) => {
    const writes: Written[] = []
    await boot($, on, world({ app: appUsage({ fable: 12 }) }), diagnostics(writes))
    expect(slashed(writes[writes.length - 1]?.path ?? '').endsWith('_local/stavovy-radek/pas.json')).toBe(true)
    const diag = lastWrite(writes)
    expect(diag['source']).toBe('app')
    expect(diag['mcpError']).toBeNull()
    expect(diag['contextPercent']).toBe(77)
    expect(diag['windows']).toEqual([
      { kind: 'seven_day', percentUsed: 22, resetsAt: '2026-11-15T23:59:59.722Z' },
      { kind: 'seven_day:Fable', percentUsed: 12, resetsAt: '2026-11-16T00:00:00.000Z' },
    ])
    expect(diag['hasRemote']).toBe(true)
    expect(diag['isWorktree']).toBe(false)
    expect(diag['lastActivityMs']).toBeNull()
    expect(typeof diag['line']).toBe('string')
    // the remote URL itself never reaches the file
    expect(writes[writes.length - 1]?.text.includes('github')).toBe(false)
    expect(writes[writes.length - 1]?.text.includes('acme')).toBe(false)
  })

  test('with the call refused: source engine and a clipped error message', async ($, on) => {
    const writes: Written[] = []
    await boot($, on, world({ app: null, remote: null, gitKind: 'file' }), diagnostics(writes))
    const diag = lastWrite(writes)
    expect(diag['source']).toBe('engine')
    expect(typeof diag['mcpError']).toBe('string')
    expect(String(diag['mcpError']).length).toBeGreaterThan(0)
    expect(String(diag['mcpError']).length <= 120).toBe(true)
    expect(diag['contextPercent']).toBe(18)
    expect(diag['hasRemote']).toBe(false)
    expect(diag['isWorktree']).toBe(true)
  })

  test('a long error message is cut to 120 characters; last activity follows a turn', async ($, on) => {
    const writes: Written[] = []
    const w = world({ app: { content: [{ type: 'text', text: 'e'.repeat(400) }], isError: true } })
    const clock = await boot($, on, w, diagnostics(writes))
    expect(String(lastWrite(writes)['mcpError'])).toBe('e'.repeat(120))
    await turnDone($)
    await clock.advance(30 * 1000)
    expect(lastWrite(writes)['lastActivityMs']).toBe(NOW)
  })

  test('the file starts with zero counters and no measurement', async ($, on) => {
    const writes: Written[] = []
    await boot($, on, world({ app: appUsage() }), diagnostics(writes))
    const diag = lastWrite(writes)
    expect(diag['measureCount']).toBe(0)
    expect(diag['measureInfo']).toBeNull()
    expect(diag['turnCount']).toBe(0)
  })

  test('without this session\'s marker nothing is written, even where the folder exists (v0.3.5)', async ($, on) => {
    const none: Written[] = []
    const clock = await boot($, on, world({ app: appUsage() }), diagnostics(none, null))
    await clock.advance(2 * MINUTE)
    expect(none).toEqual([])
  })

  test('the marker of another session does not switch the diagnostics on (v0.3.5)', async ($, on) => {
    const other: Written[] = []
    const clock = await boot($, on, world({ app: appUsage() }), diagnostics(other, 'diag-sess-2.on'))
    await clock.advance(2 * MINUTE)
    expect(other).toEqual([])
  })

  // The counters are read through the file: the test engine has no `$.state`, and the file is
  // what the mod's author reads anyway. It is rewritten on every 30 s tick.
  function measureOf($: Engine, changed: UsageUnit[]) {
    return $.session.measure({
      context: { window: 200000, tokens: 36000, percent: 18 },
      rateLimits: [],
      changed,
    })
  }

  test('a measurement is counted and recorded, the first (ignored) one as well (v0.3.2)', async ($, on) => {
    const writes: Written[] = []
    const clock = await boot($, on, world({ usage: usageOf(18, []) }), diagnostics(writes))
    await clock.advance(7 * MINUTE)

    await measureOf($, ['context', 'cost'])
    await clock.advance(30 * 1000)
    let diag = lastWrite(writes)
    expect(diag['measureCount']).toBe(1)
    expect(diag['measureInfo']).toEqual({
      atMs: NOW + 7 * MINUTE,
      changed: ['context', 'cost'],
      seen: false,
    })

    await measureOf($, ['rateLimits'])
    await clock.advance(30 * 1000)
    diag = lastWrite(writes)
    expect(diag['measureCount']).toBe(2)
    expect(diag['measureInfo']).toEqual({
      atMs: NOW + 7 * MINUTE + 30 * 1000,
      changed: ['rateLimits'],
      seen: true,
    })
  })

  test('the measurement count goes on over a new session.start, the seen flag starts over (v0.3.2)', async ($, on) => {
    const writes: Written[] = []
    const clock = await boot($, on, world({ usage: usageOf(18, []) }), diagnostics(writes))
    await measureOf($, ['context'])
    await measureOf($, ['cost'])

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await measureOf($, ['context', 'cost'])
    await clock.advance(30 * 1000)

    const diag = lastWrite(writes)
    expect(diag['measureCount']).toBe(3)
    expect((diag['measureInfo'] as { seen: boolean }).seen).toBe(false)
  })

  test('counting changes nothing about what the measurement returns or does (v0.3.2)', async ($, on) => {
    await boot($, on, world({ usage: usageOf(18, []) }))
    const result = await measureOf($, ['context', 'cost'])
    expect(result.changed).toEqual(['context', 'cost'])
  })

  test('turn.complete counts every turn, a subagent\'s too, and no measurement (v0.3.2)', async ($, on) => {
    const writes: Written[] = []
    const clock = await boot($, on, world({ usage: usageOf(18, []) }), diagnostics(writes))
    await turnDone($)
    await turnDone($, 'agent-1')
    await turnDone($)
    await clock.advance(30 * 1000)
    const diag = lastWrite(writes)
    expect(diag['turnCount']).toBe(3)
    expect(diag['measureCount']).toBe(0)
    expect(diag['measureInfo']).toBeNull()
  })

  test('the older fields of the file are all still there (v0.3.2)', async ($, on) => {
    const writes: Written[] = []
    const clock = await boot($, on, world({ app: appUsage() }), diagnostics(writes))
    await turnDone($)
    await measureOf($, ['context', 'cost'])
    await clock.advance(30 * 1000)
    const diag = lastWrite(writes)
    for (const key of ['nowMs', 'line', 'renderCount', 'lastRenderMs', 'source', 'mcpError',
      'windows', 'contextPercent', 'hasRemote', 'isWorktree', 'lastActivityMs',
      'measureCount', 'measureInfo', 'turnCount', 'isTurnRunning']) {
      expect(key in diag).toBe(true)
    }
    expect(diag['lastActivityMs']).toBe(NOW)
  })

  test('the file tells whether a turn is running (v0.3.3)', async ($, on) => {
    const writes: Written[] = []
    const clock = await boot($, on, world({ usage: usageOf(18, []) }), diagnostics(writes))
    expect(lastWrite(writes)['isTurnRunning']).toBe(false)

    await turnBegins($)
    await clock.advance(30 * 1000)
    expect(lastWrite(writes)['isTurnRunning']).toBe(true)
    expect(String(lastWrite(writes)['line'])).toContain('cache 60 min · tah běží')

    await turnDone($)
    await clock.advance(30 * 1000)
    expect(lastWrite(writes)['isTurnRunning']).toBe(false)
  })

  test('nothing is written where the diagnostic folder does not exist', async ($, on) => {
    const writes: Written[] = []
    await boot($, on, world({ app: appUsage() }), (o) => {
      o('fs.exists', () => ({ value: false }))
      o('fs.write', (_$, e) => {
        writes.push({ path: e.path, text: e.text })
        return { value: undefined }
      })
    })
    expect(writes.length).toBe(0)
  })
})
