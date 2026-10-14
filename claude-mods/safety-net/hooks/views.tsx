// safety-net: the three panes. Each builder takes the surface's elements, the width it may use,
// the values it shows and the press handlers; every row is cut to the width. Nothing here reads
// or writes state.

import type { RenderElement } from 'claude-code'

import type { BinView, ModCheckView, SafetyCatch, SafetySettings } from '../types'
import { bigTile, choiceChip, goldChip, heading, line, quietButton, slateChip, titleBar } from './look'
import type { Kit } from './look'
import { AMBER, GOLD, GREEN, MUTED, TEXT, fit, pad, tileWidth, tilesAcross } from './look-text'
import { ago, catchTone, clockTime, formatBytes, formatCount, plural, wrapLines } from './logic'

type Act = () => unknown

export const BIN_EMPTY = 'The Bin is empty. Files Claude deletes with rm land here first.'
const PURGE_LABEL = 'Empty items older than 14 days'

function lines(kit: Kit, text: string, columns: number, color: string, keyBase: string, max = 50): RenderElement[] {
  return wrapLines(text, columns, max).map((l, k) => line(kit, l, columns, color, `${keyBase}-${k}`))
}

// ─── /safety ────────────────────────────────────────────────────────────────

export type SafetyActs = {
  setBlast: (isOn: boolean) => unknown
  setDelete: (isOn: boolean) => unknown
  openBin: Act
  close: Act
}

export function safetyView(
  kit: Kit,
  columns: number,
  settings: SafetySettings,
  catches: readonly SafetyCatch[],
  bin: BinView,
  act: SafetyActs,
): RenderElement {
  const { Box, Text } = kit
  const isAllOn = settings.blastRadius && settings.safeDelete
  const isAllOff = !settings.blastRadius && !settings.safeDelete
  const right = isAllOn ? 'all on' : isAllOff ? 'off' : 'partly on'
  const labelWidth = Math.max(1, Math.min(14, columns - 11))
  const switchRow = (key: string, label: string, isOn: boolean, set: (isOn: boolean) => unknown, hint: string) => (
    <Box key={key} flexDirection="column" width={columns} marginTop={1}>
      <Box flexDirection="row" width={columns}>
        <Text color={TEXT} wrap="truncate-end">
          {pad(label, labelWidth)}
        </Text>
        <Box flexDirection="row" gap={1}>
          {choiceChip(kit, `${key}-on`, 'On', isOn, () => set(true))}
          {choiceChip(kit, `${key}-off`, 'Off', !isOn, () => set(false))}
        </Box>
      </Box>
      {line(kit, hint, columns, MUTED)}
    </Box>
  )
  const recent = catches.slice(-5).reverse()
  const items = bin.batches.reduce((s, b) => s + b.count, 0)
  const bytes = bin.batches.reduce((s, b) => s + b.bytes, 0)
  const toneColor = { good: GREEN, warn: AMBER, gold: GOLD }
  const across = tilesAcross(columns, 2)
  const tile = Math.min(columns, tileWidth(columns, across))
  const size = formatBytes(bytes)
  const cut = size.lastIndexOf(' ')
  const sizeValue = cut < 0 ? size : size.slice(0, cut)
  const sizeUnit = cut < 0 ? '' : size.slice(cut + 1)
  return (
    <Box flexDirection="column" width={columns}>
      {titleBar(kit, 'Safety net', right, columns)}
      {switchRow('blast', 'Blast radius', settings.blastRadius, act.setBlast, 'Measures what a command would destroy; asks first when it is a lot.')}
      {switchRow('delete', 'Safe delete', settings.safeDelete, act.setDelete, 'A plain rm moves files to the Bin, so /undo-delete can put them back.')}
      {heading(kit, 'Last catches', columns)}
      {recent.length === 0 && line(kit, 'Nothing caught yet.', columns, MUTED, 'no-catches')}
      {recent.map((c, k) => {
        const tone = catchTone(c.outcome)
        return (
          <Box key={`catch-${k}`} flexDirection="row" width={columns}>
            <Text color={toneColor[tone.tone]}>{`${tone.glyph} `}</Text>
            <Text color={TEXT} wrap="truncate-end">
              {fit(`${clockTime(c.at)}  ${c.outcome}: ${c.summary}`, Math.max(1, columns - 2))}
            </Text>
          </Box>
        )
      })}
      {heading(kit, 'Bin', columns)}
      <Box flexDirection={across > 1 ? 'row' : 'column'} gap={across > 1 ? 1 : 0} width={columns} marginTop={1}>
        {bigTile(kit, 'bin-items', formatCount(items), items === 1 ? 'Item in the Bin' : 'Items in the Bin', tile, GOLD)}
        {bigTile(kit, 'bin-size', sizeValue, `${sizeUnit} in the Bin`.trim(), tile)}
      </Box>
      {line(
        kit,
        bin.batches.length === 0 ? 'The Bin is empty.' : `${plural(bin.batches.length, 'batch', 'batches')}, kept for 14 days`,
        columns,
        MUTED,
        'bin-count',
      )}
      <Box flexDirection="row" gap={1} marginTop={1}>
        {slateChip(kit, 'open-bin', 'Open Bin', act.openBin)}
        {quietButton(kit, 'close', 'Close', act.close)}
      </Box>
    </Box>
  )
}

// ─── /bin ───────────────────────────────────────────────────────────────────

export type BinActs = {
  restore: (id: string) => unknown
  purge: Act
  close: Act
}

export function binView(kit: Kit, columns: number, bin: BinView, act: BinActs): RenderElement {
  const { Box, Text } = kit
  const bytes = bin.batches.reduce((s, b) => s + b.bytes, 0)
  const right = bin.batches.length === 0 ? 'empty' : `${plural(bin.batches.length, 'batch', 'batches')} · ${formatBytes(bytes)}`
  const chipWidth = 9
  const textWidth = Math.max(4, columns - chipWidth - 1)
  const isFooterRow = columns >= PURGE_LABEL.length + 2 + 1 + 5
  return (
    <Box flexDirection="column" width={columns}>
      {titleBar(kit, 'The Bin', right, columns)}
      {bin.note !== '' && (
        <Box flexDirection="column" marginTop={1}>
          {lines(kit, bin.note, columns, /could not|no longer|failed/i.test(bin.note) ? AMBER : /^Nothing/.test(bin.note) ? MUTED : GREEN, 'note', 4)}
        </Box>
      )}
      {bin.batches.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {lines(kit, BIN_EMPTY, columns, TEXT, 'empty', 4)}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} gap={1}>
          {bin.batches.slice(0, 40).map(b => (
            <Box key={`batch-${b.id}`} flexDirection="row" width={columns}>
              <Box flexDirection="column" width={textWidth}>
                <Text color={TEXT} wrap="truncate-end">
                  {fit(`${ago(b.at, bin.asOf)} · ${plural(b.count, 'item')} · ${formatBytes(b.bytes)}`, textWidth)}
                </Text>
                <Text color={MUTED} wrap="truncate-end">
                  {fit(b.names.join(', '), textWidth)}
                </Text>
              </Box>
              <Box marginLeft={1}>{slateChip(kit, `restore-${b.id}`, 'Restore', () => act.restore(b.id))}</Box>
            </Box>
          ))}
          {bin.batches.length > 40 && line(kit, `… and ${bin.batches.length - 40} older batches`, columns, MUTED, 'more')}
        </Box>
      )}
      {line(kit, 'Kept in ~/.claude/mod-data/safety-net/bin for 14 days.', columns, MUTED, 'where')}
      <Box flexDirection={isFooterRow ? 'row' : 'column'} gap={isFooterRow ? 1 : 0} marginTop={1}>
        {slateChip(kit, 'purge', fit(PURGE_LABEL, Math.max(1, columns - 2)), act.purge)}
        {quietButton(kit, 'close', 'Close', act.close)}
      </Box>
    </Box>
  )
}

// ─── Mod Check ──────────────────────────────────────────────────────────────

export type CheckActs = { copy: Act; close: Act }

const VERDICT_LINE = {
  safe: { glyph: '✓', text: 'Looks safe', color: GREEN },
  closer: { glyph: '⚠', text: 'Look closer', color: AMBER },
  dont: { glyph: '■', text: "Don't install", color: AMBER },
} as const

const SEVERE = new Set(['obfuscation', 'shell', 'secrets'])

export function checkView(kit: Kit, columns: number, v: ModCheckView, act: CheckActs): RenderElement {
  const { Box, Text } = kit
  const right = `${v.name} ${v.version}`.trim()
  const close = quietButton(kit, 'close', 'Close', act.close)
  if (v.status === 'idle') {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBar(kit, 'Mod Check', right, columns)}
        <Box flexDirection="column" marginTop={1}>
          {lines(kit, 'Run /modcheck with a folder, an owner/repo or a git URL to check a mod before you install it.', columns, TEXT, 'idle', 4)}
        </Box>
        <Box marginTop={1}>{close}</Box>
      </Box>
    )
  }
  if (v.status === 'working') {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBar(kit, 'Mod Check', right, columns)}
        <Box flexDirection="column" marginTop={1}>
          {line(kit, `◆ Checking ${v.name}…`, columns, GOLD, 'working')}
          {line(kit, v.step, columns, MUTED, 'step')}
          {v.validator.length > 0 && line(kit, v.validatorOk ? 'Validator passed.' : 'Validator reported problems.', columns, v.validatorOk ? GREEN : AMBER, 'vstate')}
        </Box>
        <Box marginTop={1}>{close}</Box>
      </Box>
    )
  }
  if (v.status === 'failed') {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBar(kit, 'Mod Check', right, columns)}
        <Box flexDirection="column" marginTop={1}>
          {line(kit, '⚠ Mod Check could not finish', columns, AMBER, 'failed')}
          {lines(kit, v.error, columns, TEXT, 'error', 6)}
        </Box>
        <Box marginTop={1}>{close}</Box>
      </Box>
    )
  }
  const verdict = VERDICT_LINE[v.verdict ?? 'closer']
  const shownRows = v.closer.slice(0, 12)
  // a check saved by an older build of safety-net has no list of unread files
  const unread: readonly string[] = Array.isArray(v.unread) ? v.unread : []
  return (
    <Box flexDirection="column" width={columns}>
      {titleBar(kit, 'Mod Check', right, columns)}
      <Box flexDirection="column" marginTop={1}>
        <Text color={verdict.color} bold wrap="truncate-end">
          {fit(`${verdict.glyph} ${verdict.text}`, columns)}
        </Text>
        {v.verdictBy === 'rules' && line(kit, 'From the scan alone: the model could not be asked.', columns, MUTED, 'by-rules')}
        {unread.length > 0 && line(kit, `⚠ Partial scan: ${plural(unread.length, 'file')} not read in full`, columns, AMBER, 'partial')}
        {v.explanation !== '' && (
          <Box flexDirection="column" marginTop={1}>
            {lines(kit, v.explanation, columns, TEXT, 'explain', 10)}
          </Box>
        )}
      </Box>
      {v.reasons.length > 0 && heading(kit, 'Why', columns)}
      {v.reasons.map((r, k) => (
        <Box key={`reason-${k}`} flexDirection="column" width={columns}>
          {wrapLines(r, Math.max(4, columns - 2), 4).map((l, j) => line(kit, `${j === 0 ? '· ' : '  '}${l}`, columns, TEXT, `reason-${k}-${j}`))}
        </Box>
      ))}
      {heading(kit, 'What it can do', columns)}
      {v.can.length === 0 &&
        lines(kit, 'Nothing the scan recognises: no programs, network calls, file writes or prompt access.', columns, MUTED, 'nothing', 3)}
      {v.can.map(c => (
        <Box key={`cap-${c.cap}`} flexDirection="row" width={columns}>
          <Text color={SEVERE.has(c.cap) ? AMBER : GOLD}>● </Text>
          <Text color={TEXT} wrap="truncate-end">
            {fit(`${c.label} (${c.count})`, Math.max(1, columns - 2))}
          </Text>
        </Box>
      ))}
      {shownRows.length > 0 && heading(kit, 'Worth a closer look', columns)}
      {shownRows.map((r, k) => (
        <Box key={`row-${k}`} flexDirection="column" width={columns}>
          {line(kit, r.where, columns, MUTED)}
          {line(kit, `  ${r.text}`, columns, TEXT)}
        </Box>
      ))}
      {v.closer.length > shownRows.length && line(kit, `… and ${v.closer.length - shownRows.length} more in the copied report`, columns, MUTED, 'more-rows')}
      {heading(kit, 'Validator', columns)}
      {v.validator.length === 0 && line(kit, 'No output.', columns, MUTED, 'no-validator')}
      {v.validator.map((l, k) => line(kit, l, columns, v.validatorOk ? TEXT : AMBER, `validator-${k}`))}
      <Box flexDirection="row" gap={1} marginTop={1}>
        {goldChip(kit, 'copy', 'Copy report', act.copy)}
        {close}
      </Box>
    </Box>
  )
}
