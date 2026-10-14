// The /changes pane: tiles, the file tree, and the replay of one edit at a time.
// Pure drawing: register.tsx reads the state and the edit's kept texts and
// hands them here with the press handlers; nothing here reads or writes.

import type { Elements, RenderElement } from 'claude-code'

import type { ChangeDeckEntry, ChangeDeckProject, ChangeDeckView } from '../types'
import { bigTile, chipWidth, goldChip, heading, linesTile, markChip, quietButton, slateChip, titleBar } from './look'
import { AMBER, GOLD, GREEN, MUTED, TEXT, cells, fit, pad, tilesAcross, tileWidth } from './look-text'
import type { TreeRow } from './logic'
import {
  buildTree,
  byParts,
  counts,
  cursorIndex,
  diffTexts,
  fitPath,
  headerLine,
  isArmedNow,
  isLoadingNow,
  limitHunks,
  messageNow,
  packParts,
  packRows,
  projectFiles,
  summary,
  totals,
  touchedFiles,
  treeRows,
  visible,
  wrapWords,
} from './logic'

export type PaneKit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

/** What the pane's buttons do; register.tsx supplies them. */
export type PaneHandlers = {
  move: (action: 'prev' | 'next' | 'latest') => unknown
  revert: (id: string) => unknown
  ask: (id: string) => unknown
  close: () => unknown
  mode: (mode: 'touched' | 'project') => unknown
  file: (path: string) => unknown
  folder: (path: string) => unknown
  showAll: () => unknown
  treeAll: () => unknown
}

/** Everything one drawing shows. */
export type PaneModel = {
  columns: number
  rows: number
  entries: readonly ChangeDeckEntry[]
  view: ChangeDeckView
  isOn: boolean
  project: ChangeDeckProject
  now: number
  /** The kept texts of the entry the replay shows; null when there are none. */
  body: { before: string | null; after: string | null } | null
}

export const EMPTY_TEXT = 'No edits yet. Every file Claude changes shows up here, in order.'

/** Width of the tree column beside the replay on a wide pane. */
const TREE_COLUMNS = 34
/** From this many columns the tree and the replay sit side by side. */
const WIDE_AT = 100
/** Below this many columns the buttons cannot fit: the pane asks for room instead. */
export const MIN_COLUMNS = 24

/** A message broken into lines that each fit `width`, so none is cut short. */
function para(kit: PaneKit, text: string, width: number, color: string, key: string): RenderElement {
  const { Box, Text } = kit
  return (
    <Box key={key} flexDirection="column" width={width}>
      {wrapWords(text, width).map((one, index) => (
        <Text key={`${key}-${index}`} color={color} wrap="truncate-end">
          {one}
        </Text>
      ))}
    </Box>
  )
}

/** Draws the whole pane at the model's body columns and rows. */
export function drawPane(kit: PaneKit, on: PaneHandlers, model: PaneModel): RenderElement {
  const { Box } = kit
  const columns = Math.max(1, Math.floor(model.columns))
  const rows = Math.max(12, Math.floor(model.rows))
  const { entries, view, isOn, project, now } = model
  const close = quietButton(kit, 'close', fit('Close', columns), () => on.close())

  if (columns < MIN_COLUMNS) {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBar(kit, 'Changes', '', columns)}
        {para(kit, 'Widen the pane to see the changes.', columns, MUTED, 'narrow')}
        <Box marginTop={1}>{close}</Box>
      </Box>
    )
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBar(kit, 'Changes', summary(entries), columns)}
        <Box flexDirection="column" marginTop={1} width={columns}>
          {para(kit, EMPTY_TEXT, columns, TEXT, 'empty')}
          {!isOn && para(kit, 'Recording is off. /changes on starts it again.', columns, AMBER, 'off')}
        </Box>
        <Box marginTop={1}>{close}</Box>
      </Box>
    )
  }

  const isWide = columns >= WIDE_AT
  const treeWidth = isWide ? TREE_COLUMNS : columns
  const replayWidth = isWide ? columns - TREE_COLUMNS - 2 : columns

  const tiles = drawTiles(kit, entries, columns)
  const tree = drawTree(kit, on, entries, view, project, treeWidth, isWide ? Math.max(8, rows - 12) : 8, now)
  const treeRowsShown = tree.rowCount + 4
  const room = Math.max(8, Math.min(400, rows - (isWide ? 17 : 17 + treeRowsShown)))
  const replay = drawReplay(kit, on, model.body, entries, view, isOn, replayWidth, room, now, close)

  return (
    <Box flexDirection="column" width={columns}>
      {titleBar(kit, 'Changes', summary(entries), columns)}
      {tiles}
      {isWide ? (
        <Box flexDirection="row" width={columns} gap={2}>
          <Box flexDirection="column" width={treeWidth}>
            {tree.element}
          </Box>
          <Box flexDirection="column" width={replayWidth}>
            {replay}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" width={columns}>
          {tree.element}
          {replay}
        </Box>
      )}
    </Box>
  )
}

/** Edits, Files and Lines, three across, then two, then one. */
function drawTiles(kit: PaneKit, entries: readonly ChangeDeckEntry[], columns: number): RenderElement {
  const { Box } = kit
  const sum = totals(entries)
  const across = tilesAcross(columns, 3, 12)
  const width = tileWidth(columns, across)
  const all = [
    bigTile(kit, 'tile-edits', String(sum.edits), 'Edits', width, GOLD),
    bigTile(kit, 'tile-files', String(sum.files), 'Files', width, TEXT),
    linesTile(kit, 'tile-lines', sum.added, sum.removed, width),
  ]
  const groups: RenderElement[][] = []
  for (let i = 0; i < all.length; i += across) groups.push(all.slice(i, i + across))
  return (
    <Box key="tiles" flexDirection="column" width={columns} marginTop={1}>
      {groups.map((group, index) => (
        <Box key={`tiles-${index}`} flexDirection="row" gap={1} width={columns}>
          {group}
        </Box>
      ))}
    </Box>
  )
}

/** The Files section: the mode chips and the tree's rows. */
function drawTree(
  kit: PaneKit,
  on: PaneHandlers,
  entries: readonly ChangeDeckEntry[],
  view: ChangeDeckView,
  project: ChangeDeckProject,
  width: number,
  cap: number,
  now: number,
): { element: RenderElement; rowCount: number } {
  const { Box, Text } = kit
  const touched = touchedFiles(entries)
  const isProject = view.mode === 'project'
  const chips = (
    <Box key="modes" flexDirection="row" gap={1} width={width}>
      {markChip(kit, 'mode-touched', 'Touched', !isProject, () => on.mode('touched'))}
      {markChip(kit, 'mode-project', 'Project', isProject, () => on.mode('project'))}
    </Box>
  )
  let rows: TreeRow[] = []
  let note = ''
  if (!isProject) {
    rows = treeRows(buildTree(touched), 'all')
  } else if (isLoadingNow(project, now)) {
    note = "Reading the project's files…"
  } else {
    rows = treeRows(buildTree(projectFiles(project.paths, touched)), new Set(view.open))
    if (project.isCapped) note = `Showing the first ${project.source === 'git' ? '3,000' : '2,000'} entries.`
    if (project.source === 'none' && project.paths.length === 0) note = 'No project files found.'
  }
  const limit = isProject ? Math.max(cap, 12) : cap
  const shown = view.treeAll ? rows : rows.slice(0, limit)
  const hidden = rows.length - shown.length
  const element = (
    <Box key="tree" flexDirection="column" width={width}>
      {heading(kit, 'Files', width, 'files-heading')}
      {chips}
      {shown.map(row => drawTreeRow(kit, on, row, view, isProject, width))}
      {hidden > 0 && quietButton(kit, 'tree-more', fit(`+${hidden} more`, width), () => on.treeAll())}
      {view.treeAll && rows.length > limit && quietButton(kit, 'tree-more', 'Show fewer', () => on.treeAll())}
      {note !== '' && (
        <Text key="tree-note" color={MUTED} wrap="truncate-end">
          {fit(note, width)}
        </Text>
      )}
    </Box>
  )
  return { element, rowCount: shown.length + (hidden > 0 || view.treeAll ? 1 : 0) + (note !== '' ? 1 : 0) }
}

/** One row of the tree, sized to `width`. */
function drawTreeRow(
  kit: PaneKit,
  on: PaneHandlers,
  row: TreeRow,
  view: ChangeDeckView,
  isProject: boolean,
  width: number,
): RenderElement {
  const { Button, Text } = kit
  const indent = '  '.repeat(Math.min(row.depth, Math.max(0, Math.floor((width - 8) / 2))))
  if (row.kind === 'dir') {
    const marker = isProject ? (row.isOpen ? '╷ ' : '› ') : ''
    const room = width - cells(indent) - cells(marker) - 1
    const label = room >= 4 ? `${indent}${marker}${fitPath(row.name, room)}/` : fit(`${indent}${marker}${row.name}/`, width)
    const color = row.hasTouched ? TEXT : MUTED
    if (!isProject) {
      return (
        <Text key={`d:${row.path}`} color={MUTED} wrap="truncate-end">
          {label}
        </Text>
      )
    }
    return (
      <Button key={`d:${row.path}`} plain onPress={() => on.folder(row.path)}>
        <Text color={color}>{label}</Text>
      </Button>
    )
  }
  const isChosen = view.filter === row.path
  const letter = row.status ?? ' '
  const letterColor = row.status === 'A' ? GREEN : row.status === 'M' ? GOLD : MUTED
  const plus = row.isTouched ? `+${row.added}` : ''
  const minus = row.isTouched ? `−${row.removed}` : ''
  const countWidth = row.isTouched ? cells(counts(row.added, row.removed)) + 1 : 0
  const lead = cells(indent) + 2
  const showCounts = width - lead - countWidth >= 6
  const nameWidth = Math.max(1, width - lead - (showCounts ? countWidth : 0))
  const nameColor = isChosen ? GOLD : row.isTouched ? TEXT : MUTED
  return (
    <Button key={`f:${row.path}`} plain onPress={() => on.file(row.path)}>
      {indent !== '' && <Text color={MUTED}>{indent}</Text>}
      <Text color={letterColor} bold>{`${letter} `}</Text>
      <Text color={nameColor} bold={isChosen}>
        {pad(row.name, nameWidth)}
      </Text>
      {showCounts && plus !== '' && <Text color={GREEN}>{` ${plus}`}</Text>}
      {showCounts && minus !== '' && <Text color={MUTED}>{` ${minus}`}</Text>}
    </Button>
  )
}

/** The Replay section: which edit, who made it, the buttons, then the diff. */
function drawReplay(
  kit: PaneKit,
  on: PaneHandlers,
  body: PaneModel['body'],
  entries: readonly ChangeDeckEntry[],
  view: ChangeDeckView,
  isOn: boolean,
  width: number,
  room: number,
  now: number,
  close: RenderElement,
): RenderElement {
  const { Box, Code, Text } = kit
  const list = visible(entries, view.filter)
  const at = cursorIndex(list, view.cursor)
  const entry = at >= 0 ? list[at] : undefined
  const parts: RenderElement[] = [heading(kit, 'Replay', width, 'replay-heading')]

  if (!isOn) parts.push(para(kit, 'Recording is off. /changes on starts it again.', width, AMBER, 'off'))

  if (entry === undefined) {
    parts.push(para(kit, `No edits to ${view.filter ?? 'this file'} yet.`, width, TEXT, 'none'))
    parts.push(<Box key="none-buttons">{close}</Box>)
    return (
      <Box key="replay" flexDirection="column" width={width}>
        {parts}
      </Box>
    )
  }

  const number = entries.indexOf(entry) + 1
  parts.push(
    <Text key="where" color={TEXT} bold wrap="truncate-end">
      {headerLine(number, entries.length, entry, width)}
    </Text>,
  )
  parts.push(
    <Box key="who" flexDirection="column" width={width}>
      {packParts(byParts(entry, now), width).map((one, index) => (
        <Text key={`who-${index}`} color={MUTED} wrap="truncate-end">
          {one}
        </Text>
      ))}
    </Box>,
  )
  if (view.filter !== null) {
    const of = list.length === 1 ? '1 edit' : `${list.length} edits`
    parts.push(para(kit, `Showing ${of} to ${view.filter}. Press the file again for all.`, width, MUTED, 'filter'))
  }

  const isArmed = isArmedNow(view, entry.id, now)
  const chips: { label: string; element: RenderElement }[] = [
    { label: '‹ Prev', element: slateChip(kit, 'prev', '‹ Prev', () => on.move('prev')) },
    { label: 'Next ›', element: goldChip(kit, 'next', 'Next ›', () => on.move('next')) },
    { label: 'Latest', element: slateChip(kit, 'latest', 'Latest', () => on.move('latest')) },
    {
      label: isArmed ? 'Press again to revert' : 'Revert this edit',
      element: slateChip(kit, 'revert', isArmed ? 'Press again to revert' : 'Revert this edit', () => on.revert(entry.id)),
    },
    {
      label: 'Ask Claude about this',
      element: slateChip(kit, 'ask', 'Ask Claude about this', () => on.ask(entry.id)),
    },
    { label: 'Close', element: close },
  ]
  const widths = chips.map((chip, index) => (index === chips.length - 1 ? cells(chip.label) : chipWidth(chip.label)))
  const packed = packRows(widths, width, 1)
  parts.push(
    <Box key="buttons" flexDirection="column" width={width} marginTop={1}>
      {packed.map((group, index) => (
        <Box key={`buttons-${index}`} flexDirection="row" gap={1}>
          {group.map(i => chips[i]!.element)}
        </Box>
      ))}
    </Box>,
  )

  const message = messageNow(view, now)
  if (message !== null) {
    const color = message.tone === 'good' ? GREEN : message.tone === 'warn' ? AMBER : MUTED
    parts.push(para(kit, message.text, width, color, 'message'))
  }

  if (entry.isTooLarge) {
    parts.push(para(kit, 'This file was over 1 MB: too large to replay, so its texts were not kept.', width, MUTED, 'large'))
  } else {
    if (body === null) {
      const why =
        entry.isDropped === true
          ? "This edit's saved copy was let go to keep the session's record under 200 MB."
          : 'The saved copy of this edit could not be read.'
      parts.push(para(kit, why, width, MUTED, 'nobody'))
    } else {
      const diff = diffTexts(body.before, body.after)
      const shown = view.showAll ? limitHunks(diff.hunks, 100_000, 90_000) : limitHunks(diff.hunks, room)
      if (entry.isLossy === true) {
        parts.push(para(kit, "Not UTF-8 text: shown as read, and it can't be reverted here.", width, MUTED, 'lossy'))
      }
      if (diff.isWhole) {
        parts.push(para(kit, 'A very long change: shown as replaced whole.', width, MUTED, 'whole'))
      }
      if (shown.source === '') {
        const none = diff.hunks.length === 0 ? 'No line changes in this edit.' : "This edit's lines are too long to show here."
        parts.push(para(kit, none, width, MUTED, 'nolines'))
      } else {
        parts.push(
          <Box key="diff" flexDirection="column" width={width} marginTop={1}>
            <Code source={shown.source} format="diff" path={entry.relPath} wrap="truncate-end" />
          </Box>,
        )
      }
      if (view.showAll && shown.isCut) {
        parts.push(para(kit, `Showing the first ${shown.lines} of ${shown.totalLines} lines.`, width, MUTED, 'cut'))
      }
      if (shown.isCut || shown.totalRows > room || view.showAll) {
        const label = view.showAll ? 'Show less' : `Show all ${shown.totalLines} lines`
        parts.push(
          <Box key="show-all-row" marginTop={1}>
            {slateChip(kit, 'show-all', fit(label, Math.max(4, width - 2)), () => on.showAll())}
          </Box>,
        )
      }
    }
  }

  return (
    <Box key="replay" flexDirection="column" width={width}>
      {parts}
    </Box>
  )
}

/** What the pane draws when its drawing failed: one plain line and Close. */
export function drawFailure(kit: PaneKit, on: PaneHandlers, columns: number): RenderElement {
  const { Box } = kit
  const width = Math.max(1, Math.floor(columns))
  return (
    <Box flexDirection="column" width={width}>
      {titleBar(kit, 'Changes', '', width)}
      {para(kit, 'The changes pane could not draw. Your edits are still recorded.', width, AMBER, 'failed')}
      <Box marginTop={1}>{quietButton(kit, 'close', fit('Close', width), () => on.close())}</Box>
    </Box>
  )
}
