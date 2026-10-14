// The session board pane: a pure drawing of the snapshot it is handed.
// Nothing here reads or writes state; presses call the handlers given.

import type { RenderElement, RenderSurface } from 'claude-code'

import type { SessionBoardNote, SessionBoardSnapshot } from '../types'
import type { Kit } from './look'
import { bigTile, heading, line, titleBar } from './look'
import { AMBER, GREEN, MUTED, TEXT, cells, spaced, tilesAcross } from './look-text'
import type { BoardRow, RowTone } from './logic'
import {
  NOTE_MS,
  boardGroups,
  boardTileWidth,
  cardWidth,
  cardsAcross,
  chunk,
  headerRight,
  helperCard,
  rowText,
  wrapWords,
} from './logic'

export const EMPTY_TEXT = 'Only this session is running. Other Claude Code sessions on this computer show up here.'
export const NO_HELPERS = 'No helpers running.'
export const OFF_TEXT = 'Off: this session shares no heartbeat, status line or notes. /sessions on turns it back on.'
export const NO_HOME_TEXT = 'No home folder, so sessions cannot be shared.'

const ROWS_PER_SECTION = 10

export type BoardView = {
  columns: number
  snapshot: SessionBoardSnapshot | null
  note: SessionBoardNote | null
  isOn: boolean
  /** Copies the resume command of the session in `row`. */
  onResume: (row: BoardRow, surface: RenderSurface) => void
}

function toneColor(tone: RowTone): string {
  if (tone === 'warn') return AMBER
  if (tone === 'good') return GREEN
  if (tone === 'muted') return MUTED
  return TEXT
}

function sessionRow(kit: Kit, row: BoardRow, columns: number, onResume: BoardView['onResume']): RenderElement {
  const { Button, Text } = kit
  const text = rowText(row.left, row.right, columns)
  const color = toneColor(row.tone)
  if (row.isSelf) {
    return (
      <Text key={`s:${row.id}`} color={color} dimColor={row.isDim} wrap="truncate-end">
        {text}
      </Text>
    )
  }
  return (
    <Button key={`s:${row.id}`} plain onPress={press => onResume(row, press.surface)}>
      <Text color={color} dimColor={row.isDim} wrap="truncate-end">
        {text}
      </Text>
    </Button>
  )
}

function section(
  kit: Kit,
  label: string,
  rows: readonly BoardRow[],
  columns: number,
  onResume: BoardView['onResume'],
): RenderElement[] {
  if (rows.length === 0) return []
  const shown = rows.slice(0, ROWS_PER_SECTION)
  const more = rows.length - shown.length
  return [
    heading(kit, label, columns, `heading-${label}`),
    ...shown.map(row => sessionRow(kit, row, columns, onResume)),
    ...(more > 0 ? [line(kit, `+${more} more`, columns, MUTED, `more-${label}`)] : []),
  ]
}

/** A sentence broken into whole-word lines, each cut to `columns`. */
function lines(kit: Kit, text: string, columns: number, color: string, key: string): RenderElement[] {
  return wrapWords(text, columns).map((one, index) => line(kit, one, columns, color, `${key}-${index}`))
}

function tiles(kit: Kit, counts: { waiting: number; working: number; done: number }, columns: number): RenderElement {
  const { Box } = kit
  const across = tilesAcross(columns, 3, 11)
  const width = boardTileWidth(columns, across)
  const isRoomy = width - 4 >= 14
  const all = [
    bigTile(kit, 'tile-waiting', String(counts.waiting), isRoomy ? 'Waiting on you' : 'Waiting', width, AMBER),
    bigTile(kit, 'tile-working', String(counts.working), 'Working', width, GREEN),
    bigTile(kit, 'tile-done', String(counts.done), 'Done', width, MUTED),
  ]
  return (
    <Box key="tiles" flexDirection="column" width={columns} marginTop={1}>
      {chunk(all, across).map((row, index) => (
        <Box key={`tiles-${index}`} flexDirection="row" gap={1} width={columns}>
          {row}
        </Box>
      ))}
    </Box>
  )
}

function helpers(kit: Kit, snapshot: SessionBoardSnapshot, columns: number): RenderElement[] {
  const { Box, Text } = kit
  const head = heading(kit, "This session's helpers", columns, 'heading-helpers')
  if (snapshot.helpers.length === 0) return [head, line(kit, NO_HELPERS, columns, MUTED, 'no-helpers')]
  const across = cardsAcross(columns)
  const width = cardWidth(columns, across)
  const cards = snapshot.helpers.slice(0, 9).map(one => helperCard(one, snapshot.now, width))
  return [
    head,
    ...chunk(cards, across).map((row, index) => (
      <Box key={`cards-${index}`} flexDirection="row" gap={2} width={columns}>
        {row.map(card => (
          <Text key={card.key} color={toneColor(card.tone)} dimColor={card.isDim} wrap="truncate-end">
            {card.text}
          </Text>
        ))}
      </Box>
    )),
  ]
}

/** The whole pane for a snapshot, sized to `columns`. */
export function drawBoard(kit: Kit, view: BoardView): RenderElement {
  const { Box } = kit
  const columns = Math.max(1, Math.floor(view.columns))
  const snapshot = view.snapshot
  if (snapshot === null) {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBar(kit, 'Sessions', '', columns)}
        {line(kit, 'Reading the sessions on this computer…', columns, MUTED, 'loading')}
      </Box>
    )
  }
  const groups = boardGroups(snapshot.beats, snapshot.selfId, snapshot.now)
  const note = view.note
  const isNoteShown = note !== null && snapshot.now - note.at < NOTE_MS
  return (
    <Box flexDirection="column" width={columns}>
      {titleBar(kit, 'Sessions', headerRight(groups, columns - cells(spaced('Sessions')) - 2), columns)}
      {!view.isOn && lines(kit, OFF_TEXT, columns, AMBER, 'off')}
      {isNoteShown && lines(kit, note.text, columns, note.isGood ? GREEN : AMBER, 'note')}
      {tiles(kit, { waiting: groups.waiting.length, working: groups.working.length, done: groups.done.length }, columns)}
      {!groups.hasOthers && (
        <Box key="empty" flexDirection="column" width={columns} marginTop={1}>
          {lines(kit, snapshot.hasHome === false ? NO_HOME_TEXT : EMPTY_TEXT, columns, MUTED, 'empty')}
        </Box>
      )}
      {groups.hasOthers && section(kit, 'Waiting on you', groups.waiting, columns, view.onResume)}
      {groups.hasOthers && section(kit, 'Working', groups.working, columns, view.onResume)}
      {groups.hasOthers && section(kit, 'Done', groups.done, columns, view.onResume)}
      {groups.hasOthers && section(kit, 'Went quiet', groups.quiet, columns, view.onResume)}
      {helpers(kit, snapshot, columns)}
    </Box>
  )
}
