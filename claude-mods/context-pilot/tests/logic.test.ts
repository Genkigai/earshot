// Pure logic: measuring, cache tax, bumps, threshold, status text, paths.

import { expect, test } from 'claude-code/testing'

import type { PilotSnapshot } from '../types'
import {
  DEFAULT_SETTINGS,
  applyHelperStep,
  applyMainStep,
  applySetting,
  bumpLine,
  contextOf,
  currentTurn,
  deltaTokens,
  freshSnapshot,
  handoffDir,
  handoffFile,
  handoffWaits,
  helperReturnNote,
  hitRate,
  markHandoff,
  markReported,
  newHelper,
  parsePilot,
  projectSlug,
  sessionHit,
  shortModel,
  stamp,
  statusText,
  summarize,
  taxOf,
  toolLabel,
  unwarn,
  windowOfModel,
  withPhase,
  wrapWords,
} from '../hooks/logic'
import type { StepUsage } from '../hooks/logic'

type Use = { name: string; input: unknown }

function usage(input: number, read: number, write: number, output = 500): StepUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  }
}

function run(
  s: PilotSnapshot,
  u: StepUsage,
  o: { turnId?: string; index?: number; toolUses?: Use[]; window?: number } = {},
): { snapshot: PilotSnapshot; fire: boolean } {
  return applyMainStep(
    s,
    {
      turnId: o.turnId ?? 't1',
      index: o.index ?? 0,
      model: 'claude-opus-5-5',
      usage: u,
      toolUses: o.toolUses ?? [],
      now: 1000,
      window: o.window ?? 200_000,
      statusPercent: null,
      costUsd: null,
    },
    DEFAULT_SETTINGS,
  )
}

test('context is measured from input, cache read and cache write, as a percent of the window', async () => {
  const u = usage(1_000, 60_000, 23_000, 4_000)
  expect(contextOf(u)).toBe(84_000)
  const { snapshot } = run(freshSnapshot(0), u)
  expect(snapshot.context).toBe(84_000)
  expect(snapshot.percent).toBe(42)
  expect(snapshot.window).toBe(200_000)
  expect(snapshot.last?.output).toBe(4_000)
  expect(windowOfModel('claude-opus-5-5[1m]')).toBe(1_000_000)
  expect(windowOfModel('claude-sonnet-4-5')).toBe(200_000)
  const onMillion = applyMainStep(
    freshSnapshot(0),
    {
      turnId: 't',
      index: 0,
      model: 'claude-opus-5-5[1m]',
      usage: u,
      toolUses: [],
      now: 0,
      window: 0,
      statusPercent: null,
      costUsd: null,
    },
    DEFAULT_SETTINGS,
  )
  expect(onMillion.snapshot.percent).toBe(8.4)
  expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
  expect(shortModel('claude-opus-5-5[1m]')).toBe('opus-5-5[1m]')
})

test('cache hit rate and tax across several requests; the first write is not tax', async () => {
  let s = freshSnapshot(0)
  s = run(s, usage(5_000, 0, 20_000), { index: 0 }).snapshot
  expect(s.last?.hit).toBe(0)
  expect(s.totals.tax).toBe(0)
  s = run(s, usage(10, 20_000, 3_000), { index: 1 }).snapshot
  expect(s.last?.tax).toBe(0)
  expect(Math.round((s.last?.hit ?? 0) * 1000)).toBe(869)
  // The cache expired: everything is written again, and what was cached is tax.
  s = run(s, usage(10, 0, 26_000), { index: 2 }).snapshot
  expect(s.last?.tax).toBe(23_000)
  s = run(s, usage(10, 26_000, 1_000), { index: 3 }).snapshot
  expect(s.last?.tax).toBe(0)
  expect(s.totals).toEqual({ requests: 4, input: 101_030, read: 46_000, written: 50_000, tax: 23_000 })
  expect(Math.round(sessionHit(s.totals) * 100)).toBe(46)
  expect(hitRate(usage(0, 0, 0))).toBe(0)
  expect(taxOf(usage(0, 0, 5_000), null)).toBe(0)
})

test('bumps: the five biggest rises ranked, labelled with what came in between', async () => {
  const read = (n: number) => usage(0, n - 1_000, 1_000)
  let s = freshSnapshot(0)
  const app = { name: 'Read', input: { file_path: '/repo/src/app.js' } }
  s = run(s, read(20_000), { turnId: 't1', index: 0, toolUses: [app] }).snapshot
  s = run(s, read(32_300), { turnId: 't1', index: 1, toolUses: [{ name: 'Bash', input: { command: 'npm test' } }] })
    .snapshot
  s = run(s, read(35_000), { turnId: 't1', index: 2, toolUses: [{ name: 'Agent', input: { description: 'Fix tests' } }] })
    .snapshot
  s = run(s, read(55_000), { turnId: 't1', index: 3 }).snapshot
  s = run(s, read(56_000), {
    turnId: 't2',
    index: 0,
    toolUses: [
      { name: 'Grep', input: { pattern: 'TODO' } },
      { name: 'Read', input: { file_path: 'b.ts' } },
    ],
  }).snapshot
  s = run(s, read(64_000), { turnId: 't2', index: 1, toolUses: [{ name: 'Edit', input: { file_path: 'app.js' } }] })
    .snapshot
  s = run(s, read(64_500), { turnId: 't2', index: 2 }).snapshot
  // A compaction: a drop, never a bump.
  s = run(s, read(30_000), { turnId: 't3', index: 0 }).snapshot
  expect(s.turn).toBe(3)
  expect(s.bumps).toEqual([
    { delta: 20_000, label: 'Agent "Fix tests"', turn: 1 },
    { delta: 12_300, label: 'Read app.js', turn: 1 },
    { delta: 8_000, label: 'Grep "TODO" +1', turn: 2 },
    { delta: 2_700, label: 'Bash npm test', turn: 1 },
    { delta: 1_000, label: 'your prompt', turn: 2 },
  ])
  expect(bumpLine({ delta: 12_300, label: 'Read app.js', turn: 4 }, 120)).toBe('+12.3k  Read app.js · turn 4')
  expect([950, 12_300, 18_000, 99_940, 140_000].map(deltaTokens)).toEqual(['950', '12.3k', '18k', '99.9k', '140k'])
  expect(bumpLine({ delta: 1_234, label: 'Read a-very-long-file-name-indeed.ts', turn: 4 }, 32).length).toBeLessThanOrEqual(32)
  expect(toolLabel('mcp__github__get_file', {})).toBe('github:get_file')
  expect(toolLabel('WebFetch', { url: 'https://example.com/a?b' })).toBe('WebFetch example.com')
})

test('the threshold fires once and re-arms only after a drop of ten points', async () => {
  let s = freshSnapshot(0)
  const at = (n: number) => usage(0, n, 0)
  const fires: boolean[] = []
  for (const tokens of [100_000, 145_000, 150_000, 125_000, 150_000, 110_000, 142_000]) {
    const out = run(s, at(tokens), { index: 1 })
    fires.push(out.fire)
    s = out.snapshot
  }
  expect(fires).toEqual([false, true, false, false, false, false, true])
  expect(s.notes).toBe(2)
  // A saved handoff lasts until the next main turn; an ask, until a second
  // new turn starts with nothing saved. Neither depends on the level.
  const measured = run(freshSnapshot(0), at(40_000), { turnId: 't1', index: 0 }).snapshot
  const saved = withPhase(measured, 'handed-off')
  expect(run(saved, at(41_000), { turnId: 't1', index: 1 }).snapshot.phase).toBe('handed-off')
  expect(run(saved, at(41_000), { turnId: 't2', index: 0 }).snapshot.phase).toBe('measuring')
  const asked = withPhase(measured, 'handing-off')
  const answered = run(asked, at(41_000), { turnId: 't2', index: 0 }).snapshot
  expect(answered.phase).toBe('handing-off')
  expect(run(answered, at(42_000), { turnId: 't3', index: 0 }).snapshot.phase).toBe('measuring')
  // The turn running now: one past the last measured when a new one has no request yet.
  expect([currentTurn(measured, null), currentTurn(measured, 't1'), currentTurn(measured, 't2')]).toEqual([1, 1, 2])
  const off = applyMainStep(
    freshSnapshot(0),
    {
      turnId: 't',
      index: 0,
      model: 'm',
      usage: at(190_000),
      toolUses: [],
      now: 0,
      window: 200_000,
      statusPercent: null,
      costUsd: null,
    },
    { ...DEFAULT_SETTINGS, isAuto: false },
  )
  expect(off.fire).toBe(false)
})

test('status line text', async () => {
  const empty = freshSnapshot(0)
  expect(statusText(empty, DEFAULT_SETTINGS)).toBeUndefined()
  expect(statusText({ ...empty, isWaiting: true }, DEFAULT_SETTINGS)).toBe('handoff waiting · /pickup')
  let s = run(empty, usage(0, 72_800, 11_200)).snapshot
  s = run(s, usage(0, 0, 84_000), { index: 1 }).snapshot
  expect(statusText(s, DEFAULT_SETTINGS)).toBe('ctx 42% · cache 43% · tax 84k')
  expect(statusText({ ...s, phase: 'handing-off' }, DEFAULT_SETTINGS)).toBe('ctx 42% · cache 43% · tax 84k · handing off…')
  expect(statusText({ ...s, phase: 'handed-off' }, DEFAULT_SETTINGS)).toBe('ctx 42% · cache 43% · tax 84k · handoff saved')
  expect(statusText(s, { ...DEFAULT_SETTINGS, showStatus: false })).toBeUndefined()
})

test('paths, stamps, slugs and the waiting rule', async () => {
  expect(projectSlug('/Users/leland/Coding/earshot')).toBe('Users-leland-Coding-earshot')
  expect(projectSlug('C:\\Users\\leland\\earshot')).toBe('C-Users-leland-earshot')
  expect(projectSlug('/')).toBe('root')
  expect(stamp(new Date(2026, 9, 14, 9, 5, 7).getTime())).toBe('20261014-090507')
  const dir = handoffDir('/Users/leland/', '/Users/leland/Coding/earshot')
  expect(dir).toBe('/Users/leland/.claude/mod-data/context-pilot/handoffs/Users-leland-Coding-earshot')
  expect(handoffFile(dir, new Date(2026, 9, 14, 9, 5, 7).getTime(), 'helper', 2)).toBe(`${dir}/20261014-090507-helper-2.md`)
  const day = 24 * 3_600_000
  expect(handoffWaits({ mtimeMs: 10 * day, now: 12 * day, sessionStart: 11 * day, pickedMtime: null })).toBe(true)
  expect(handoffWaits({ mtimeMs: 10 * day, now: 12 * day, sessionStart: 11 * day, pickedMtime: 10 * day })).toBe(false)
  expect(handoffWaits({ mtimeMs: 2 * day, now: 12 * day, sessionStart: 11 * day, pickedMtime: null })).toBe(false)
  expect(handoffWaits({ mtimeMs: 11.5 * day, now: 12 * day, sessionStart: 11 * day, pickedMtime: null })).toBe(false)
  expect(summarize('# Ship the parser\n\nSaved 2026-10-14 09:05 · session · /x\n\n## Goal\n- Parse it all')).toEqual({
    title: 'Ship the parser',
    summary: 'Parse it all',
  })
})

test('a helper that saved a handoff is reported with its path', async () => {
  let list = markHandoff([newHelper('a1', 'Fix tests', 0)], 'a1', '/h/x-helper.md', 5)
  expect(helperReturnNote(list[0]!)).toBe(
    'This helper stopped early and saved a handoff at /h/x-helper.md. Start a fresh helper with the Agent tool ' +
      "and give it that handoff's text to finish the remaining work.",
  )
  list = markReported(list, 'a1')
  expect(list[0]?.isReported).toBe(true)
  expect(helperReturnNote(newHelper('a2', '', 0))).toBeNull()
})

test('a helper is asked once per run, and an ask that never went in is taken back', async () => {
  const step = { id: 'a1', description: 'Fix tests', model: 'claude-opus-5-5', usage: usage(0, 69_000, 1_000), now: 0 }
  const first = applyHelperStep([], step, DEFAULT_SETTINGS)
  expect(first.due?.percent).toBe(35)
  expect(first.list[0]?.isWarned).toBe(true)
  expect(applyHelperStep(first.list, { ...step, now: 1 }, DEFAULT_SETTINGS).due).toBeNull()
  const back = unwarn(first.list, 'a1')
  expect(back[0]?.isWarned).toBe(false)
  expect(back[0]?.warnedFor).toBeNull()
  expect(helperReturnNote(back[0]!)).toBeNull()
  // Main's window, when the helper runs main's model.
  const wide = applyHelperStep([], { ...step, window: 1_000_000 }, DEFAULT_SETTINGS)
  expect(wide.list[0]?.percent).toBe(7)
  expect(wide.due).toBeNull()
})

test('settings commands parse and validate', async () => {
  expect(parsePilot('')).toEqual({ kind: 'open' })
  expect(parsePilot('off')).toEqual({ kind: 'auto', isOn: false })
  expect(parsePilot('set main 65')).toEqual({ kind: 'set', name: 'main', value: '65' })
  expect(parsePilot('set main')).toEqual({ kind: 'help' })
  const ok = applySetting(DEFAULT_SETTINGS, 'main', '65%')
  expect('settings' in ok && ok.settings.mainThreshold).toBe(65)
  expect('error' in applySetting(DEFAULT_SETTINGS, 'main', '200')).toBe(true)
  expect('error' in applySetting(DEFAULT_SETTINGS, 'nope', '1')).toBe(true)
  const off = applySetting(DEFAULT_SETTINGS, 'status', 'off')
  expect('settings' in off && off.settings.showStatus).toBe(false)
  expect(wrapWords("Nothing measured yet. Numbers appear after Claude's first reply.", 20).every(l => l.length <= 20)).toBe(
    true,
  )
})
