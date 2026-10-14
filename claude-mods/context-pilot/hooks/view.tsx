// The /pilot pane. Draws from plain data and calls the handlers it is given;
// it reads and writes nothing itself.

import type { RenderElement } from 'claude-code'

import type { PilotHandoff, PilotHelper, PilotSettings, PilotSnapshot } from '../types'
import type { Kit } from './look'
import { bigTile, goldChip, heading, line, meter, quietButton, slateChip, titleBar } from './look'
import { AMBER, GOLD, GREEN, MUTED, TEXT, bars3, clock, pad, tilesAcross, tileWidth, tokens } from './look-text'
import {
  bumpLine,
  compareLine,
  contextLook,
  handoffLine,
  helperRow,
  isNearLimit,
  lastLine,
  narrowLine,
  scaleLine,
  sessionHit,
  shortModel,
  visibleHelpers,
  wrapWords,
} from './logic'

export type PaneData = {
  snapshot: PilotSnapshot
  settings: PilotSettings
  helpers: readonly PilotHelper[]
  handoff: PilotHandoff | null
  now: number
  columns: number
}

export type PaneActions = {
  writeNow: () => unknown
  toggleAuto: () => unknown
  copyPath: () => unknown
  close: () => unknown
}

export const EMPTY_TEXT = "Nothing measured yet. Numbers appear after Claude's first reply."

/** Below this many columns the pane draws only its title, one line and Close. */
export const NARROW = 20

function rows<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function tiles(kit: Kit, d: PaneData): RenderElement {
  const { Box } = kit
  const s = d.snapshot
  const across = tilesAcross(d.columns, 3)
  const width = tileWidth(d.columns, across)
  const look = contextLook(s.percent, d.settings.mainThreshold)
  const all = [
    bigTile(kit, 'tile-context', `${Math.round(s.percent)}%`, look.label, width, look.tone === 'good' ? GREEN : AMBER),
    bigTile(kit, 'tile-cache', `${Math.round(sessionHit(s.totals) * 100)}%`, 'Cache hit', width, GOLD),
    bigTile(kit, 'tile-tax', tokens(s.totals.tax), 'Cache tax', width, TEXT),
  ]
  return (
    <Box key="tiles" flexDirection="column" width={d.columns} marginTop={1}>
      {rows(all, across).map((row, index) => (
        <Box key={`tiles-${index}`} flexDirection="row" gap={1} width={d.columns}>
          {row}
        </Box>
      ))}
    </Box>
  )
}

function growth(kit: Kit, d: PaneData): RenderElement {
  const { Box, Text } = kit
  const values = d.snapshot.history.slice(-d.columns)
  const chart = bars3(values)
  return (
    <Box key="growth" flexDirection="column" width={d.columns}>
      {heading(kit, 'Growth', d.columns, 'heading-growth')}
      {chart.map((row, index) => (
        <Text key={`bar-${index}`} color={GOLD} wrap="truncate-end">
          {row === '' ? ' ' : row}
        </Text>
      ))}
      {line(kit, scaleLine(d.snapshot.history, d.columns, d.columns), d.columns, MUTED, 'scale')}
    </Box>
  )
}

function jumps(kit: Kit, d: PaneData): RenderElement {
  const { Box } = kit
  const bumps = d.snapshot.bumps
  return (
    <Box key="jumps" flexDirection="column" width={d.columns}>
      {heading(kit, 'Biggest jumps', d.columns, 'heading-jumps')}
      {bumps.length === 0
        ? line(kit, 'No jumps yet.', d.columns, MUTED, 'jumps-none')
        : bumps.map((bump, index) => line(kit, bumpLine(bump, d.columns), d.columns, TEXT, `jump-${index}`))}
    </Box>
  )
}

function helperLine(kit: Kit, d: PaneData, helper: PilotHelper): RenderElement {
  const { Box, Text } = kit
  const part = helperRow(helper, d.now, d.columns)
  const isNear = !part.isHanded && isNearLimit(helper, d.now, d.settings)
  const nameWidth = Math.max(1, d.columns - (part.time.length + 1 + part.pct.length + (part.meterWidth > 0 ? part.meterWidth + 1 : 0)))
  return (
    <Box key={`helper-${helper.id}`} flexDirection="row" width={d.columns}>
      <Text color={isNear ? AMBER : TEXT} wrap="truncate-end">
        {pad(part.name, nameWidth)}
      </Text>
      <Text color={MUTED}>{` ${part.time}`}</Text>
      <Text color={part.isHanded ? GREEN : isNear ? AMBER : TEXT}>{part.pct}</Text>
      {part.meterWidth > 0 && <Text> </Text>}
      {part.meterWidth > 0 && meter(kit, helper.percent * (100 / Math.max(1, d.settings.helperContext)), part.meterWidth, isNear ? AMBER : GOLD)}
    </Box>
  )
}

function helpers(kit: Kit, d: PaneData): RenderElement {
  const { Box } = kit
  const shown = visibleHelpers(d.helpers, d.now)
  return (
    <Box key="helpers" flexDirection="column" width={d.columns}>
      {heading(kit, 'Helpers', d.columns, 'heading-helpers')}
      {shown.length === 0
        ? line(kit, 'No helpers running.', d.columns, MUTED, 'helpers-none')
        : shown.map(helper => helperLine(kit, d, helper))}
    </Box>
  )
}

function handoff(kit: Kit, d: PaneData, act: PaneActions): RenderElement {
  const { Box } = kit
  const summary = d.handoff === null ? '' : d.handoff.summary !== '' ? d.handoff.summary : d.handoff.title
  return (
    <Box key="handoff" flexDirection="column" width={d.columns}>
      {heading(kit, 'Handoff', d.columns, 'heading-handoff')}
      {line(kit, handoffLine(d.handoff, d.now, d.columns), d.columns, d.snapshot.phase === 'handed-off' ? GREEN : TEXT, 'handoff-line')}
      {summary !== '' && line(kit, summary, d.columns, MUTED, 'handoff-summary')}
      <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={1} width={d.columns} marginTop={1}>
        {goldChip(kit, 'write', 'Write handoff now', act.writeNow)}
        {slateChip(kit, 'auto', `Auto-handoff: ${d.settings.isAuto ? 'on' : 'off'}`, act.toggleAuto)}
        {slateChip(kit, 'copy', 'Copy path', act.copyPath)}
        {quietButton(kit, 'close', 'Close', act.close)}
      </Box>
    </Box>
  )
}

/** The pane in a very narrow room: the title, the figures in one line, Close. */
function narrow(kit: Kit, d: PaneData, act: PaneActions): RenderElement {
  const { Box } = kit
  return (
    <Box flexDirection="column" width={d.columns}>
      {titleBar(kit, 'Context pilot', '', d.columns)}
      {line(kit, narrowLine(d.snapshot), d.columns, d.snapshot.requests === 0 ? MUTED : TEXT, 'narrow-line')}
      {d.columns >= 5 && quietButton(kit, 'close', 'Close', act.close)}
    </Box>
  )
}

/** The whole pane, no row wider than `d.columns`. */
export function drawPane(kit: Kit, d: PaneData, act: PaneActions): RenderElement {
  if (d.columns < NARROW) return narrow(kit, d, act)
  const { Box, Text } = kit
  const s = d.snapshot
  const model = s.model !== '' ? shortModel(s.model) : ''
  const right = [model, s.sessionStart > 0 ? clock(d.now - s.sessionStart) : ''].filter(part => part !== '').join(' · ')
  const isEmpty = s.requests === 0
  return (
    <Box flexDirection="column" width={d.columns}>
      {titleBar(kit, 'Context pilot', right, d.columns)}
      {isEmpty ? (
        <Box key="empty" flexDirection="column" width={d.columns} marginTop={1}>
          {wrapWords(EMPTY_TEXT, d.columns).map((text, index) => (
            <Text key={`empty-${index}`} color={MUTED} wrap="truncate-end">
              {text}
            </Text>
          ))}
        </Box>
      ) : (
        <Box key="measured" flexDirection="column" width={d.columns}>
          {tiles(kit, d)}
          {line(kit, compareLine(s), d.columns, MUTED, 'compare')}
          {line(kit, lastLine(s), d.columns, MUTED, 'last')}
          {growth(kit, d)}
          {jumps(kit, d)}
        </Box>
      )}
      {helpers(kit, d)}
      {handoff(kit, d, act)}
    </Box>
  )
}
