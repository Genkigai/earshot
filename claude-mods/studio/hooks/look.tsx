// The shared look: title rule, headings, chips, meters and big-number tiles.
// Every builder takes the surface's element table and the width it may use,
// and returns a tree no wider than that width. Nothing here reads or writes state.

import type { Elements, RenderElement } from 'claude-code'

import {
  AMBER,
  GOLD,
  GREEN,
  HAIR,
  INK,
  MUTED,
  SLATE,
  TEXT,
  bigRows,
  bigWidth,
  canBig,
  cells,
  fit,
  headingParts,
  meterParts,
  ruleParts,
  spaced,
} from './look-text'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

type Press = () => unknown

/** Bold spaced capitals on the left, a muted note on the right, then the gold rule. */
export function titleBar(kit: Kit, title: string, right: string, columns: number): RenderElement {
  const { Box, Text } = kit
  const shownTitle = fit(spaced(title), columns)
  const room = columns - cells(shownTitle) - 2
  const shownRight = room >= 4 ? fit(right, room) : ''
  const { gold, hair } = ruleParts(cells(shownTitle), columns)
  return (
    <Box key="title" flexDirection="column" width={columns}>
      <Box flexDirection="row" justifyContent="space-between" width={columns}>
        <Text bold color={TEXT} wrap="truncate-end">
          {shownTitle}
        </Text>
        {shownRight !== '' && (
          <Text color={MUTED} wrap="truncate-end">
            {shownRight}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" width={columns}>
        <Text color={GOLD}>{gold}</Text>
        <Text color={HAIR}>{hair}</Text>
      </Box>
    </Box>
  )
}

/** A section heading: small muted capitals, then a hairline to the edge. */
export function heading(kit: Kit, label: string, columns: number, key?: string): RenderElement {
  const { Box, Text } = kit
  const parts = headingParts(label, columns)
  return (
    <Box key={key ?? `heading-${label}`} flexDirection="row" width={columns} marginTop={1}>
      <Text color={MUTED} wrap="truncate-end">
        {parts.label}
      </Text>
      {parts.hair !== '' && <Text color={HAIR}> {parts.hair.slice(1)}</Text>}
    </Box>
  )
}

/** The main action of a screen: a gold chip with dark bold text. */
export function goldChip(kit: Kit, key: string, label: string, onPress: Press, hotkey?: string): RenderElement {
  const { Button, Text } = kit
  return (
    <Button key={key} plain onPress={onPress} {...(hotkey !== undefined ? { hotkey } : {})}>
      <Text backgroundColor={GOLD} color={INK} bold>
        {` ${label} `}
      </Text>
    </Button>
  )
}

/** Any other button: a slate chip with light text. */
export function slateChip(kit: Kit, key: string, label: string, onPress: Press, hotkey?: string): RenderElement {
  const { Button, Text } = kit
  return (
    <Button key={key} plain onPress={onPress} {...(hotkey !== undefined ? { hotkey } : {})}>
      <Text backgroundColor={SLATE} color={TEXT}>
        {` ${label} `}
      </Text>
    </Button>
  )
}

/** A selected tab or toggle: gold when chosen, slate when not. */
export function choiceChip(kit: Kit, key: string, label: string, isChosen: boolean, onPress: Press): RenderElement {
  return isChosen ? goldChip(kit, key, label, onPress) : slateChip(kit, key, label, onPress)
}

/** Cancel and other quiet actions: plain muted text. */
export function quietButton(kit: Kit, key: string, label: string, onPress: Press): RenderElement {
  const { Button, Text } = kit
  return (
    <Button key={key} plain onPress={onPress}>
      <Text color={MUTED}>{label}</Text>
    </Button>
  )
}

/** A thin meter: filled part in `color`, the rest a hairline. */
export function meter(kit: Kit, percent: number, width: number, color: string = GOLD): RenderElement {
  const { Box, Text } = kit
  const { fill, rest } = meterParts(percent, width)
  return (
    <Box flexDirection="row" width={width}>
      <Text color={color}>{fill}</Text>
      <Text color={HAIR}>{rest}</Text>
    </Box>
  )
}

/**
 * A rounded tile with a big three-row number and a small capital label.
 * A value too wide for big numerals is drawn as plain bold text instead.
 */
export function bigTile(
  kit: Kit,
  key: string,
  value: string,
  label: string,
  width: number,
  color: string = TEXT,
): RenderElement {
  const { Box, Text } = kit
  const inner = Math.max(1, width - 4)
  const isBig = canBig(value) && bigWidth(value) <= inner
  const rows = isBig ? bigRows(value) : [fit(value, inner), '', '']
  return (
    <Box
      key={key}
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={HAIR}
      paddingX={1}
    >
      {rows.map((row, index) => (
        <Text key={`r${index}`} color={color} bold={!isBig} wrap="truncate-end">
          {row === '' ? ' ' : row}
        </Text>
      ))}
      <Text color={MUTED} wrap="truncate-end">
        {fit(label.toUpperCase(), inner)}
      </Text>
    </Box>
  )
}

/** One line of plain text, cut to the width so it never wraps. */
export function line(kit: Kit, text: string, columns: number, color: string = TEXT, key?: string): RenderElement {
  const { Text } = kit
  return (
    <Text key={key} color={color} wrap="truncate-end">
      {fit(text, columns)}
    </Text>
  )
}

export const tone = { good: GREEN, warn: AMBER, muted: MUTED, text: TEXT, gold: GOLD }

// ---------------------------------------------------------------------------
// Added for studio: the same pieces in the person's chosen accent.

/** `titleBar` with the rule in `accent`; `isSpaced` false keeps the title as written (a page title). */
export function titleBarIn(
  kit: Kit,
  title: string,
  right: string,
  columns: number,
  accent: string,
  isSpaced = true,
): RenderElement {
  const { Box, Text } = kit
  const shownTitle = fit(isSpaced ? spaced(title) : title, columns)
  const room = columns - cells(shownTitle) - 2
  const shownRight = room >= 4 ? fit(right, room) : ''
  const { gold, hair } = ruleParts(cells(shownTitle), columns)
  return (
    <Box key="title" flexDirection="column" width={columns}>
      <Box flexDirection="row" justifyContent="space-between" width={columns}>
        <Text bold color={TEXT} wrap="truncate-end">
          {shownTitle}
        </Text>
        {shownRight !== '' && (
          <Text color={MUTED} wrap="truncate-end">
            {shownRight}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" width={columns}>
        <Text color={accent}>{gold}</Text>
        <Text color={HAIR}>{hair}</Text>
      </Box>
    </Box>
  )
}

/** The main action in the person's accent: an accent chip with dark bold text. */
export function accentChip(kit: Kit, key: string, label: string, onPress: Press, accent: string): RenderElement {
  const { Button, Text } = kit
  return (
    <Button key={key} plain onPress={onPress}>
      <Text backgroundColor={accent} color={INK} bold>
        {` ${label} `}
      </Text>
    </Button>
  )
}

/** A chosen chip in the accent, the others slate. */
export function choiceChipIn(
  kit: Kit,
  key: string,
  label: string,
  isChosen: boolean,
  onPress: Press,
  accent: string,
): RenderElement {
  return isChosen ? accentChip(kit, key, label, onPress, accent) : slateChip(kit, key, label, onPress)
}
