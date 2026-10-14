// The Prompt Upgrade panes. Each draws from plain data and calls the handlers
// it is given; nothing here reads or writes state.

import type { Elements, RenderElement } from 'claude-code'

import type { UpgradeEntry, UpgradeFlow } from '../types'
import type { Kit } from './look'
import { goldChip, heading, line, quietButton, slateChip, titleBar } from './look'
import { AMBER, GOLD, GREEN, HAIR, INK, MUTED, SLATE, TEXT, cells, fit } from './look-text'
import {
  answeredCount,
  bulletLines,
  historyRow,
  HISTORY_LIMIT,
  numberParts,
  numbersLine,
  oneLine,
  stepIndex,
  trackerSegments,
  wrapText,
} from './logic'
import type { Tone } from './logic'

/** The shared kit, plus the text field where the surface has one (not on mobile). */
export type FlowKit = Kit & { Input?: Elements['terminal']['Input'] }

export const TITLE = 'Prompt Upgrade'
export const HISTORY_TITLE = 'Prompt history'
export const MOBILE_COMPOSE = 'Type /better followed by your prompt.'
export const SAFE_LINE = 'Your prompt is safe. Nothing was sent.'
export const EMPTY_HISTORY = 'No upgrades yet. Type /better followed by a rough prompt.'
export const HISTORY_LEGEND = '✓ sent  ○ not sent'

export type FlowData = {
  flow: UpgradeFlow
  isOn: boolean
  columns: number
}

export type FlowActions = {
  compose: (text: string) => unknown
  /** Every change of the compose field, so a close never loses it. */
  composeDraft: (text: string) => unknown
  choose: (index: number, option: string) => unknown
  openOther: (index: number) => unknown
  other: (index: number, text: string) => unknown
  skip: (index: number) => unknown
  skipRest: () => unknown
  run: () => unknown
  runText: (text: string) => unknown
  /** Every change of the Edit field. */
  draft: (text: string) => unknown
  edit: (editing: boolean) => unknown
  copy: () => unknown
  cancel: () => unknown
  retry: () => unknown
  sendOriginal: () => unknown
}

export type HistoryData = { entries: readonly UpgradeEntry[]; now: number; columns: number }
export type HistoryActions = { open: (id: string) => unknown; close: () => unknown }

const TONE_COLOR: Record<Tone, string> = { done: GREEN, current: GOLD, rest: MUTED, sep: MUTED }

/** The four steps across the top, cut to the width. */
function tracker(kit: FlowKit, current: number, columns: number): RenderElement {
  const { Box, Text } = kit
  const segments = trackerSegments(current, columns)
  return (
    <Box key="tracker" flexDirection="row" width={columns} marginTop={1}>
      {segments.map((s, i) => (
        <Text key={`t${i}`} color={TONE_COLOR[s.tone]} bold={s.tone === 'current'} wrap="truncate-end">
          {s.text}
        </Text>
      ))}
    </Box>
  )
}

/** Lines of text drawn one Text each, none wider than `width`. */
function lines(kit: FlowKit, key: string, text: readonly string[], width: number, color: string = TEXT): RenderElement[] {
  const { Text } = kit
  return text.map((one, i) => (
    <Text key={`${key}-${i}`} color={color} wrap="truncate-end">
      {one === '' ? ' ' : fit(one, width)}
    </Text>
  ))
}

/** A rounded card with a small capital label and word-wrapped text. */
function card(
  kit: FlowKit,
  key: string,
  label: string,
  body: string,
  width: number,
  border: string,
  labelColor: string,
): RenderElement {
  const { Box, Text } = kit
  const inner = Math.max(1, width - 4)
  return (
    <Box key={key} flexDirection="column" width={width} borderStyle="round" borderColor={border} paddingX={1}>
      <Text color={labelColor} wrap="truncate-end">
        {fit(label.toUpperCase(), inner)}
      </Text>
      {lines(kit, `${key}-l`, wrapText(body, inner), inner)}
    </Box>
  )
}

/** A status line under a card: a gold dot and what is happening, wrapped beside it. */
function status(kit: FlowKit, text: string, columns: number): RenderElement {
  const { Box, Text } = kit
  const width = Math.max(1, columns - 2)
  return (
    <Box key="status" flexDirection="row" width={columns} marginTop={1}>
      <Text color={GOLD}>● </Text>
      <Box flexDirection="column" width={width}>
        {lines(kit, 'status', wrapText(text, width), width, MUTED)}
      </Box>
    </Box>
  )
}

function row(kit: FlowKit, key: string, columns: number, children: RenderElement[], marginTop = 1): RenderElement {
  const { Box } = kit
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={1} width={columns} marginTop={marginTop}>
      {children}
    </Box>
  )
}

/** A chip label never wider than the room: the chip adds a cell each side. */
function chipLabel(label: string, room: number): string {
  return fit(label, Math.max(1, room - 2))
}

function composeScreen(kit: FlowKit, d: FlowData, a: FlowActions): RenderElement[] {
  const { Input } = kit
  const c = d.columns
  const out: RenderElement[] = [heading(kit, 'Your prompt', c, 'h-compose')]
  if (Input !== undefined) {
    out.push(
      <Input
        key="compose"
        placeholder="Type a rough prompt"
        submitLabel="upgrade"
        autoFocus
        onInput={value => a.composeDraft(value)}
        onSubmit={value => a.compose(value)}
      />,
    )
    out.push(...lines(kit, 'compose-hint', wrapText('Enter starts the upgrade. Nothing is sent until you press Run.', c), c, MUTED))
  } else {
    out.push(...lines(kit, 'compose-mobile', wrapText(MOBILE_COMPOSE, c), c))
  }
  out.push(row(kit, 'compose-actions', c, [quietButton(kit, 'cancel', 'Cancel', a.cancel)]))
  return out
}

function loadingScreen(kit: FlowKit, d: FlowData, a: FlowActions, text: string): RenderElement[] {
  const { Box } = kit
  const c = d.columns
  return [
    <Box key="reading" flexDirection="column" width={c} marginTop={1}>
      {card(kit, 'card-original', 'Your prompt', d.flow.original, c, HAIR, MUTED)}
    </Box>,
    status(kit, text, c),
    row(kit, 'loading-actions', c, [quietButton(kit, 'cancel', 'Cancel', a.cancel)]),
  ]
}

function badge(kit: FlowKit, key: string, n: number, answer: UpgradeFlow['answers'][number]): RenderElement {
  const { Text } = kit
  if (answer === null || answer === undefined) {
    return (
      <Text key={key} backgroundColor={GOLD} color={INK} bold>
        {` ${n} `}
      </Text>
    )
  }
  if (answer.kind === 'skip') {
    return (
      <Text key={key} backgroundColor={SLATE} color={MUTED}>
        {' · '}
      </Text>
    )
  }
  return (
    <Text key={key} backgroundColor={GREEN} color={INK} bold>
      {' ✓ '}
    </Text>
  )
}

function questionsScreen(kit: FlowKit, d: FlowData, a: FlowActions): RenderElement[] {
  const { Box, Text, Input } = kit
  const c = d.columns
  const flow = d.flow
  const total = flow.questions.length
  const answered = answeredCount(flow)
  const textWidth = Math.max(1, c - 4)
  const out: RenderElement[] = [
    line(kit, `${answered} of ${total} answered`, c, MUTED, 'answered'),
    row(
      kit,
      'questions-actions',
      c,
      [
        goldChip(kit, 'skip-rest', chipLabel('Skip the rest, upgrade now', c), a.skipRest),
        quietButton(kit, 'cancel', 'Cancel', a.cancel),
      ],
      0,
    ),
  ]
  flow.questions.forEach((q, i) => {
    const answer = flow.answers[i] ?? null
    const chosen = answer !== null && answer.kind === 'option' ? answer.text : null
    const chips: RenderElement[] = q.options.map((option, j) =>
      chosen === option
        ? goldChip(kit, `q${i}-o${j}`, chipLabel(option, textWidth), () => a.choose(i, option))
        : slateChip(kit, `q${i}-o${j}`, chipLabel(option, textWidth), () => a.choose(i, option)),
    )
    if (Input !== undefined) {
      const isOther = answer !== null && answer.kind === 'other'
      chips.push(
        isOther
          ? goldChip(kit, `q${i}-other`, chipLabel('Other (type it)', textWidth), () => a.openOther(i))
          : slateChip(kit, `q${i}-other`, chipLabel('Other (type it)', textWidth), () => a.openOther(i)),
      )
    }
    chips.push(quietButton(kit, `q${i}-skip`, answer !== null && answer.kind === 'skip' ? 'Skipped' : 'Skip', () => a.skip(i)))
    out.push(
      <Box key={`q${i}`} flexDirection="column" width={c} marginTop={1}>
        <Box flexDirection="row" width={c}>
          {badge(kit, `q${i}-badge`, i + 1, answer)}
          <Text> </Text>
          <Box flexDirection="column" width={textWidth}>
            {lines(kit, `q${i}-text`, wrapText(q.question, textWidth), textWidth)}
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={textWidth} marginLeft={4}>
          {chips}
        </Box>
        {answer !== null && answer.kind === 'other' && (
          <Box flexDirection="column" width={textWidth} marginLeft={4}>
            {lines(kit, `q${i}-said`, bulletLines(answer.text, textWidth, '› '), textWidth)}
          </Box>
        )}
        {Input !== undefined && flow.otherOpen === i && (
          <Box flexDirection="column" width={textWidth} marginLeft={4}>
            <Input
              key={`q${i}-other-input`}
              placeholder="Type your answer"
              submitLabel="answer"
              autoFocus
              onSubmit={value => a.other(i, value)}
            />
          </Box>
        )}
      </Box>,
    )
  })
  return out
}

function numbersRow(kit: FlowKit, flow: UpgradeFlow, columns: number): RenderElement {
  const { Box, Text } = kit
  const whole = numbersLine(flow.original, flow.upgrade, flow.added)
  if (cells(whole) > columns) return line(kit, whole, columns, TEXT, 'numbers')
  const p = numberParts(flow.original, flow.upgrade, flow.added)
  return (
    <Box key="numbers" flexDirection="row" width={columns} marginTop={1}>
      <Text color={TEXT} bold>
        {p.before}
      </Text>
      <Text color={MUTED}> → </Text>
      <Text color={GOLD} bold>
        {p.after}
      </Text>
      <Text color={MUTED}> · </Text>
      <Text color={GREEN}>{p.added}</Text>
    </Box>
  )
}

function editCard(kit: FlowKit, flow: UpgradeFlow, width: number, a: FlowActions): RenderElement {
  const { Box, Text, Input } = kit
  const inner = Math.max(1, width - 4)
  return (
    <Box key="card-edit" flexDirection="column" width={width} borderStyle="round" borderColor={GOLD} paddingX={1}>
      <Text color={GOLD} wrap="truncate-end">
        {fit('EDIT, THEN PRESS ENTER TO RUN', inner)}
      </Text>
      {Input !== undefined && (
        <Input
          key="edit"
          value={oneLine(flow.upgrade)}
          submitLabel="run"
          autoFocus
          onInput={value => a.draft(value)}
          onSubmit={value => a.runText(value)}
        />
      )}
    </Box>
  )
}

function reviewScreen(kit: FlowKit, d: FlowData, a: FlowActions): RenderElement[] {
  const { Box } = kit
  const c = d.columns
  const flow = d.flow
  const isEditing = flow.editing && kit.Input !== undefined
  const out: RenderElement[] = [
    numbersRow(kit, flow, c),
    row(kit, 'review-actions', c, [
      goldChip(kit, 'run', 'Run it', a.run),
      slateChip(kit, 'edit', isEditing ? 'Stop editing' : 'Edit', () => a.edit(!isEditing)),
      slateChip(kit, 'copy', 'Copy', a.copy),
      quietButton(kit, 'cancel', 'Cancel', a.cancel),
    ]),
    heading(kit, 'What I added', c, 'h-added'),
  ]
  if (flow.added.length === 0) {
    out.push(line(kit, 'Nothing new; the wording was tightened.', c, MUTED, 'added-none'))
  } else {
    flow.added.forEach((item, i) => out.push(...lines(kit, `added-${i}`, bulletLines(item, c), c)))
  }
  const isSide = c >= 90
  const cardWidth = isSide ? Math.floor((c - 1) / 2) : c
  const left = card(kit, 'card-original', 'Your prompt', flow.original, cardWidth, HAIR, MUTED)
  const right = isEditing ? editCard(kit, flow, cardWidth, a) : card(kit, 'card-upgrade', 'Upgrade', flow.upgrade, cardWidth, GOLD, GOLD)
  out.push(
    <Box key="cards" flexDirection={isSide ? 'row' : 'column'} columnGap={1} width={c} marginTop={1}>
      {left}
      {right}
    </Box>,
  )
  return out
}

function errorScreen(kit: FlowKit, d: FlowData, a: FlowActions): RenderElement[] {
  const { Box, Text } = kit
  const c = d.columns
  const inner = Math.max(1, c - 4)
  const message = d.flow.error?.message ?? 'The model could not be asked.'
  return [
    <Box key="error" flexDirection="column" width={c} borderStyle="round" borderColor={AMBER} paddingX={1} marginTop={1}>
      <Text color={AMBER} bold wrap="truncate-end">
        {fit('⚠ The upgrade paused.', inner)}
      </Text>
      {lines(kit, 'safe', wrapText(SAFE_LINE, inner), inner)}
      {lines(kit, 'why', wrapText(message, inner), inner, MUTED)}
    </Box>,
    row(kit, 'error-actions', c, [
      goldChip(kit, 'retry', 'Try again', a.retry),
      slateChip(kit, 'send-original', 'Send my original', a.sendOriginal),
      quietButton(kit, 'cancel', 'Cancel', a.cancel),
    ]),
    <Box key="error-original" flexDirection="column" width={c} marginTop={1}>
      {card(kit, 'card-original', 'Your prompt', d.flow.original, c, HAIR, MUTED)}
    </Box>,
  ]
}

/** The upgrade pane: title, tracker, then the current step's screen. */
export function drawFlow(kit: FlowKit, d: FlowData, a: FlowActions): RenderElement {
  const { Box } = kit
  const c = d.columns
  const flow = d.flow
  let body: RenderElement[]
  switch (flow.step) {
    case 'questions-loading':
      body = loadingScreen(kit, d, a, 'Reading your prompt and picking the questions that would help most…')
      break
    case 'questions':
      body = questionsScreen(kit, d, a)
      break
    case 'rewrite-loading': {
      const used = answeredCount(flow)
      const note = used === 0 ? 'Writing the upgrade…' : `Writing the upgrade with ${used} answer${used === 1 ? '' : 's'}…`
      body = loadingScreen(kit, d, a, note)
      break
    }
    case 'review':
      body = reviewScreen(kit, d, a)
      break
    case 'error':
      body = errorScreen(kit, d, a)
      break
    default:
      body = composeScreen(kit, d, a)
  }
  const notice = flow.notice ?? ''
  return (
    <Box flexDirection="column" width={c}>
      {titleBar(kit, TITLE, d.isOn ? 'auto on' : 'auto off', c)}
      {tracker(kit, stepIndex(flow), c)}
      {notice !== '' && (
        <Box key="notice" flexDirection="column" width={c} marginTop={1}>
          {lines(kit, 'notice', wrapText(`⚠ ${notice}`, c), c, AMBER)}
        </Box>
      )}
      {body}
    </Box>
  )
}

/** The history pane: the last upgrades, newest first; pressing one reopens its review. */
export function drawHistory(kit: Kit, d: HistoryData, a: HistoryActions): RenderElement {
  const { Box, Button, Text } = kit
  const c = d.columns
  const rows = d.entries.slice(0, HISTORY_LIMIT).map(entry => {
    const r = historyRow(entry, d.now, c)
    return (
      <Button key={`h-${entry.id}`} plain onPress={() => a.open(entry.id)}>
        <Text color={MUTED}>{r.when} </Text>
        {r.mark !== '' && <Text color={entry.sent === true ? GREEN : AMBER}>{r.mark}</Text>}
        <Text color={TEXT}>{r.snippet}</Text>
        <Text color={GOLD}>{r.words}</Text>
      </Button>
    )
  })
  return (
    <Box flexDirection="column" width={c}>
      {titleBar(kit, HISTORY_TITLE, `${d.entries.length} of ${HISTORY_LIMIT}`, c)}
      {heading(kit, 'Last upgrades', c, 'h-history')}
      {rows.length === 0 ? line(kit, EMPTY_HISTORY, c, MUTED, 'history-empty') : <Box flexDirection="column">{rows}</Box>}
      {d.entries.some(entry => entry.sent !== undefined) && line(kit, HISTORY_LEGEND, c, MUTED, 'history-legend')}
      <Box flexDirection="row" marginTop={1}>
        {quietButton(kit, 'close', 'Close', a.close)}
      </Box>
    </Box>
  )
}
