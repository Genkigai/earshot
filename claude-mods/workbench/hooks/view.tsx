// workbench's drawings: the Idea Shelf, Assumptions and Reflect panes and the
// band above the prompt. Each takes the surface's elements, the data to draw
// and the handlers to wire, and returns a tree no wider than `columns`.
// Nothing here reads or writes state.

import type { Elements, RenderElement } from 'claude-code'

import type {
  WorkbenchGuess,
  WorkbenchIdea,
  WorkbenchNotice,
  WorkbenchReflect,
  WorkbenchShelfUi,
} from '../types'
import { choiceChip, goldChip, quietButton, slateChip, titleBar } from './look'
import type { Kit } from './look'
import { AMBER, GOLD, GREEN, HAIR, INK, MUTED, TEXT, cells, fit, pad } from './look-text'
import {
  ASSUME_EMPTY,
  REFLECT_EMPTY,
  REFLECT_FAILED,
  REFLECT_LOADING,
  REFLECT_NOTHING,
  SHELF_EMPTY,
  addLabel,
  ago,
  armedLabel,
  bandLayout,
  checkedLine,
  firstLine,
  fitStart,
  keptLines,
  labelFor,
  projectName,
  shelfRight,
  wrapLines,
  wrongCount,
} from './logic'

/** The elements a pane draws with; `Input` only where the surface has one. */
export type FieldKit = Kit & { Input?: Elements['terminal']['Input'] }

type Press = () => unknown

const TONES = { good: GREEN, warn: AMBER, muted: MUTED } as const

/** Lines of text, wrapped to `columns`, at most `maxLines`. */
function paragraph(kit: Kit, key: string, text: string, columns: number, color: string, maxLines = 4): RenderElement {
  const { Box, Text } = kit
  return (
    <Box key={key} flexDirection="column" width={columns}>
      {wrapLines(text, columns, maxLines).map((row, index) => (
        <Text key={`${key}-${index}`} color={color} wrap="truncate-end">
          {row === '' ? ' ' : row}
        </Text>
      ))}
    </Box>
  )
}

function noticeRow(kit: Kit, notice: WorkbenchNotice | null, columns: number): RenderElement | null {
  if (notice === null) return null
  const { Box } = kit
  return (
    <Box key="notice" marginTop={1} width={columns}>
      {paragraph(kit, 'notice-text', notice.text, columns, TONES[notice.tone], 3)}
    </Box>
  )
}

type Chip = { el: RenderElement; width: number }

/** The cells a row of buttons takes, one cell between each. */
function rowWidth(buttons: readonly Chip[]): number {
  return buttons.reduce((sum, one) => sum + one.width, 0) + Math.max(0, buttons.length - 1)
}

/** Buttons in one row when they fit, else one row each (in order). */
function buttonRows(kit: Kit, key: string, buttons: Chip[], columns: number, marginTop = 1): RenderElement {
  const { Box } = kit
  if (rowWidth(buttons) <= columns) {
    return (
      <Box key={key} flexDirection="row" gap={1} marginTop={marginTop} width={columns}>
        {buttons.map(one => one.el)}
      </Box>
    )
  }
  return (
    <Box key={key} flexDirection="column" marginTop={marginTop} width={columns}>
      {buttons.map(one => one.el)}
    </Box>
  )
}

/** A chip's label: the full one where its chip fits the width, else the short one. */
function chipLabel(full: string, short: string, columns: number): string {
  return cells(full) + 2 <= columns ? full : short
}

const chipWidth = (label: string) => cells(label) + 2

// ── Idea Shelf ─────────────────────────────────────────────────────────────

export type ShelfData = {
  columns: number
  root: string
  ideas: readonly WorkbenchIdea[]
  ui: WorkbenchShelfUi
  now: number
}

export type ShelfActions = {
  send: (id: string) => unknown
  edit: (id: string) => unknown
  saveEdit: (id: string, text: string) => unknown
  cancelEdit: Press
  remove: (id: string) => unknown
  sendAll: Press
  close: Press
}

export const SHELF_TITLE = 'Idea shelf'

/** An idea's Send, Edit and Delete; an armed Delete says to press again in the room it has. */
function ideaChips(kit: Kit, id: string, isArmed: boolean, columns: number, a: ShelfActions): Chip[] {
  const { Button, Text } = kit
  const send = { el: goldChip(kit, `send-${id}`, 'Send', () => a.send(id)), width: chipWidth('Send') }
  const edit = { el: slateChip(kit, `edit-${id}`, 'Edit', () => a.edit(id)), width: chipWidth('Edit') }
  if (!isArmed) {
    return [send, edit, { el: quietButton(kit, `delete-${id}`, 'Delete', () => a.remove(id)), width: cells('Delete') }]
  }
  const label = armedLabel(columns - send.width - edit.width - 2)
  const armed = (
    <Button key={`delete-${id}`} plain onPress={() => a.remove(id)}>
      <Text color={AMBER}>{label}</Text>
    </Button>
  )
  return [send, edit, { el: armed, width: cells(label) }]
}

export function drawShelf(kit: FieldKit, d: ShelfData, a: ShelfActions): RenderElement {
  const { Box, Text, Input } = kit
  const columns = d.columns
  const rows: (RenderElement | null)[] = [titleBar(kit, SHELF_TITLE, shelfRight(d.root, d.ideas.length), columns)]

  if (d.ideas.length === 0) {
    rows.push(
      <Box key="empty" marginTop={1} width={columns}>
        {paragraph(kit, 'empty-text', SHELF_EMPTY, columns, MUTED)}
      </Box>,
    )
  }

  for (const idea of d.ideas) {
    const id = idea.id
    const when = ago(d.now, idea.at)
    const textRoom = Math.max(1, columns - cells(when) - 1)
    const isEditing = d.ui.editingId === id && Input !== undefined
    const isArmed = d.ui.armedId === id
    rows.push(
      <Box key={`idea-${id}`} flexDirection="column" width={columns} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between" width={columns}>
          <Text color={TEXT} wrap="truncate-end">
            {fit(firstLine(idea.text), textRoom)}
          </Text>
          <Text color={MUTED}>{when}</Text>
        </Box>
        {isEditing && Input !== undefined ? (
          <Box flexDirection="column" width={columns}>
            <Input
              key={`edit-field-${id}`}
              value={idea.text}
              submitLabel="save"
              autoFocus
              onSubmit={value => a.saveEdit(id, value)}
            />
            <Box flexDirection="row" gap={1}>
              {quietButton(kit, `edit-cancel-${id}`, 'Cancel', a.cancelEdit)}
            </Box>
          </Box>
        ) : (
          buttonRows(kit, `chips-${id}`, ideaChips(kit, id, isArmed, columns, a), columns, 0)
        )}
      </Box>,
    )
  }

  rows.push(noticeRow(kit, d.ui.notice, columns))

  const footer: Chip[] = []
  if (d.ideas.length > 0) {
    const label = labelFor('Send all as one prompt', 'Send all', columns - cells('Close') - 1)
    footer.push({ el: slateChip(kit, 'send-all', label, a.sendAll), width: chipWidth(label) })
  }
  footer.push({ el: quietButton(kit, 'close', 'Close', a.close), width: cells('Close') })
  rows.push(buttonRows(kit, 'footer', footer, columns))

  return (
    <Box flexDirection="column" width={columns}>
      {rows}
    </Box>
  )
}

// ── Assumptions ────────────────────────────────────────────────────────────

export type AssumeData = {
  columns: number
  isOn: boolean
  guesses: readonly WorkbenchGuess[]
  notice: WorkbenchNotice | null
}

export type AssumeActions = {
  mark: (id: string, mark: 'right' | 'wrong' | 'skip') => unknown
  correct: (id: string, text: string) => unknown
  send: Press
  allRight: Press
  close: Press
}

export const ASSUME_TITLE = 'Assumptions'

/**
 * A guess's Right, Wrong and Skip, under its text: in one row where they fit
 * beside the badge's indent, else one under another (the indent dropped when
 * even a chip would not fit beside it).
 */
function markChips(kit: Kit, guess: WorkbenchGuess, indent: number, columns: number, a: AssumeActions): RenderElement {
  const { Box, Button, Text } = kit
  const id = guess.id
  const skipLabel = guess.mark === 'skip' ? 'Skipped' : 'Skip'
  const chips: Chip[] = [
    { el: choiceChip(kit, `right-${id}`, 'Right', guess.mark === 'right', () => a.mark(id, 'right')), width: chipWidth('Right') },
    { el: choiceChip(kit, `wrong-${id}`, 'Wrong', guess.mark === 'wrong', () => a.mark(id, 'wrong')), width: chipWidth('Wrong') },
    {
      el: (
        <Button key={`skip-${id}`} plain onPress={() => a.mark(id, 'skip')}>
          <Text color={guess.mark === 'skip' ? TEXT : MUTED}>{skipLabel}</Text>
        </Button>
      ),
      width: cells(skipLabel),
    },
  ]
  const widest = Math.max(...chips.map(one => one.width))
  const left = rowWidth(chips) <= columns - indent || widest <= columns - indent ? indent : 0
  const room = Math.max(1, columns - left)
  return (
    <Box key={`marks-${id}`} marginLeft={left} width={room}>
      {buttonRows(kit, `marks-row-${id}`, chips, room, 0)}
    </Box>
  )
}

export function drawAssumptions(kit: FieldKit, d: AssumeData, a: AssumeActions): RenderElement {
  const { Box, Text, Input } = kit
  const columns = d.columns
  const list = d.guesses
  const rows: (RenderElement | null)[] = [titleBar(kit, ASSUME_TITLE, d.isOn ? '' : 'off', columns)]

  if (list.length > 0) {
    const isAllChecked = list.every(one => one.mark !== null)
    rows.push(
      <Text key="checked" color={isAllChecked ? GREEN : MUTED} wrap="truncate-end">
        {fit(checkedLine(list), columns)}
      </Text>,
    )
  }
  if (!d.isOn) {
    rows.push(
      <Box key="off" marginTop={1} width={columns}>
        {paragraph(kit, 'off-text', 'Assumption Check is off. Type /assumptions on to turn it on.', columns, AMBER, 2)}
      </Box>,
    )
  }
  if (list.length === 0) {
    rows.push(
      <Box key="empty" marginTop={1} width={columns}>
        {paragraph(kit, 'empty-text', ASSUME_EMPTY, columns, MUTED)}
      </Box>,
    )
  }

  const badgeWidth = cells(` ${list.length} `)
  const inner = Math.max(1, columns - badgeWidth - 1)
  list.forEach((guess, index) => {
    const id = guess.id
    const isMarked = guess.mark !== null
    const badge = isMarked ? (
      <Text key="badge" color={GREEN} bold>
        {pad(' ✓', badgeWidth)}
      </Text>
    ) : (
      <Text key="badge" backgroundColor={GOLD} color={INK} bold>
        {pad(` ${index + 1}`, badgeWidth)}
      </Text>
    )
    rows.push(
      <Box key={`guess-${id}`} flexDirection="column" width={columns} marginTop={1}>
        <Box flexDirection="row" width={columns}>
          {badge}
          <Box flexDirection="column" width={inner} marginLeft={1}>
            {wrapLines(guess.text, inner, 3).map((row, at) => (
              <Text key={`t${at}`} color={TEXT} wrap="truncate-end">
                {row}
              </Text>
            ))}
            {guess.why !== '' && (
              <Text key="why" color={MUTED} wrap="truncate-end">
                {fit(guess.why, inner)}
              </Text>
            )}
          </Box>
        </Box>
        {markChips(kit, guess, badgeWidth + 1, columns, a)}
        {guess.mark === 'wrong' && Input !== undefined && (
          <Box marginLeft={badgeWidth + 1} width={inner}>
            <Input
              key={`fix-${id}`}
              placeholder="What's right? (optional)"
              value={guess.correction}
              submitLabel="keep"
              onInput={value => a.correct(id, value)}
              onSubmit={value => a.correct(id, value)}
            />
          </Box>
        )}
        {guess.mark === 'wrong' && Input === undefined && guess.correction !== '' && (
          <Box marginLeft={badgeWidth + 1} width={inner}>
            <Text color={MUTED} wrap="truncate-end">
              {fit(guess.correction, inner)}
            </Text>
          </Box>
        )}
      </Box>,
    )
  })

  rows.push(noticeRow(kit, d.notice, columns))

  const footer: Chip[] = []
  if (wrongCount(list) > 0) {
    const label = chipLabel('Send corrections', 'Send', columns)
    footer.push({ el: goldChip(kit, 'send-corrections', label, a.send), width: chipWidth(label) })
  }
  if (list.length > 0) {
    const label = chipLabel('Mark all right', 'All right', columns)
    footer.push({ el: slateChip(kit, 'all-right', label, a.allRight), width: chipWidth(label) })
  }
  footer.push({ el: quietButton(kit, 'close', 'Close', a.close), width: cells('Close') })
  rows.push(buttonRows(kit, 'footer', footer, columns))

  return (
    <Box flexDirection="column" width={columns}>
      {rows}
    </Box>
  )
}

// ── Reflect ────────────────────────────────────────────────────────────────

export type ReflectData = { columns: number; reflect: WorkbenchReflect }

export type ReflectActions = {
  keep: (index: number, keep: boolean) => unknown
  add: Press
  copy: Press
  retry: Press
  close: Press
}

export const REFLECT_TITLE = 'Reflect'

export function drawReflect(kit: FieldKit, d: ReflectData, a: ReflectActions): RenderElement {
  const { Box, Text } = kit
  const columns = d.columns
  const r = d.reflect
  const rows: (RenderElement | null)[] = [titleBar(kit, REFLECT_TITLE, projectName(r.target.replace(/[\\/]CLAUDE\.md$/, '')), columns)]

  if (r.target !== '') {
    rows.push(
      <Text key="target" color={MUTED} wrap="truncate-end">
        {fitStart(`Into ${r.target}`, columns)}
      </Text>,
    )
    if (r.isNew && !r.isAdded) {
      rows.push(
        <Box key="new" width={columns}>
          {paragraph(kit, 'new-text', "It doesn't exist yet: adding lines creates it.", columns, AMBER, 2)}
        </Box>,
      )
    }
  }

  const close = { el: quietButton(kit, 'close', 'Close', a.close), width: cells('Close') }

  if (r.step === 'loading' || r.step === 'idle') {
    rows.push(
      <Box key="loading" marginTop={1} width={columns}>
        <Text color={MUTED} wrap="truncate-end">
          {fit(REFLECT_LOADING, columns)}
        </Text>
      </Box>,
    )
    // A reload mid-read drops the answer: Start over asks again (a late answer is ignored).
    const restart = { el: slateChip(kit, 'restart', 'Start over', a.retry), width: chipWidth('Start over') }
    rows.push(buttonRows(kit, 'footer', [restart, close], columns))
  } else if (r.step === 'error') {
    const inner = Math.max(1, columns - 4)
    rows.push(
      <Box key="error" flexDirection="column" width={columns} marginTop={1} borderStyle="round" borderColor={HAIR} paddingX={1}>
        {paragraph(kit, 'error-text', REFLECT_FAILED, inner, AMBER, 3)}
      </Box>,
    )
    rows.push(
      buttonRows(
        kit,
        'footer',
        [{ el: goldChip(kit, 'retry', 'Try again', a.retry), width: chipWidth('Try again') }, close],
        columns,
      ),
    )
  } else if (r.step === 'nothing' || r.step === 'empty') {
    rows.push(
      <Box key="quiet" marginTop={1} width={columns}>
        {paragraph(kit, 'quiet-text', r.step === 'nothing' ? REFLECT_NOTHING : REFLECT_EMPTY, columns, MUTED, 3)}
      </Box>,
    )
    rows.push(buttonRows(kit, 'footer', [close], columns))
  } else {
    r.items.forEach((item, index) => {
      const why = [item.why, item.isPresent ? 'already in CLAUDE.md' : ''].filter(part => part !== '').join(' · ')
      rows.push(
        <Box key={`item-${index}`} flexDirection="column" width={columns} marginTop={1}>
          {wrapLines(item.text, columns, 3).map((row, at) => (
            <Text key={`t${at}`} color={item.keep ? TEXT : MUTED} wrap="truncate-end">
              {row}
            </Text>
          ))}
          {why !== '' && (
            <Text key="why" color={MUTED} wrap="truncate-end">
              {fit(why, columns)}
            </Text>
          )}
          <Box flexDirection="row" gap={1} width={columns}>
            {choiceChip(kit, `keep-${index}`, 'Keep', item.keep, () => a.keep(index, true))}
            {choiceChip(kit, `skip-${index}`, 'Skip', !item.keep, () => a.keep(index, false))}
          </Box>
        </Box>,
      )
    })
    rows.push(noticeRow(kit, r.notice, columns))
    const kept = keptLines(r.items).length
    const footer: Chip[] = []
    if (kept > 0 && !r.isAdded) {
      const label = labelFor(addLabel(kept), `Add ${kept}`, columns)
      footer.push({ el: goldChip(kit, 'add', label, a.add), width: chipWidth(label) })
    }
    if (kept > 0) footer.push({ el: slateChip(kit, 'copy', 'Copy', a.copy), width: chipWidth('Copy') })
    footer.push(close)
    rows.push(buttonRows(kit, 'footer', footer, columns))
  }

  return (
    <Box flexDirection="column" width={columns}>
      {rows}
    </Box>
  )
}

// ── The band above the prompt ──────────────────────────────────────────────

export type BandActions = { check: Press; dismiss: Press }

export function drawBand(kit: Kit, count: number, columns: number, a: BandActions): RenderElement {
  const { Box, Text } = kit
  const layout = bandLayout(count, columns)
  const rest = layout.text.startsWith('◆') ? layout.text.slice(1) : layout.text
  return (
    <Box flexDirection="row" width={columns}>
      {layout.text.startsWith('◆') && <Text color={GOLD}>◆</Text>}
      <Text color={TEXT} wrap="truncate-end">
        {rest}
      </Text>
      {layout.hasCheck && goldChip(kit, 'check', 'Check them', a.check)}
      {layout.hasDismiss && (
        <Box marginLeft={1}>{quietButton(kit, 'dismiss', 'Dismiss', a.dismiss)}</Box>
      )}
    </Box>
  )
}
