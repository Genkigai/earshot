// The progress band above the prompt. Draws a BandModel whose strings are
// already cut to the width (logic.ts); reads and writes nothing.

import type { RenderElement } from 'claude-code'

import type { Kit } from './look'
import { AMBER, GREEN, HAIR, MUTED, TEXT } from './look-text'
import type { BandModel, Tone } from './logic'

export function toneColor(tone: Tone, accent: string): string {
  switch (tone) {
    case 'good':
      return GREEN
    case 'warn':
      return AMBER
    case 'muted':
      return MUTED
    case 'accent':
      return accent
    default:
      return TEXT
  }
}

export function drawBand(kit: Kit, model: BandModel, columns: number, accent: string): RenderElement {
  const { Box, Text } = kit
  const head = model.header
  return (
    <Box key="studio-band" flexDirection="column" width={columns}>
      <Box key="header" flexDirection="row" width={columns}>
        <Text color={toneColor(head.glyphTone, accent)}>{`${head.glyph} `}</Text>
        <Text color={toneColor(head.leftTone, accent)} bold={head.leftBold} wrap="truncate-end">
          {head.left}
        </Text>
        {head.right !== '' && <Text>{' '.repeat(head.gap)}</Text>}
        {head.right !== '' && (
          <Text color={MUTED} wrap="truncate-end">
            {head.right}
          </Text>
        )}
      </Box>
      {model.rows.map((row, index) => (
        <Box key={`step-${index}`} flexDirection="row" width={columns}>
          <Text color={toneColor(row.glyphTone, accent)}>{`${row.glyph} `}</Text>
          <Text color={toneColor(row.nameTone, accent)} bold={row.nameBold} wrap="truncate-end">
            {row.name}
          </Text>
          {row.meterFill + row.meterRest !== '' && <Text>{'  '}</Text>}
          {row.meterFill !== '' && <Text color={toneColor(row.meterTone, accent)}>{row.meterFill}</Text>}
          {row.meterRest !== '' && <Text color={HAIR}>{row.meterRest}</Text>}
          {row.word !== '' && <Text>{'  '}</Text>}
          {row.word !== '' && <Text color={toneColor(row.wordTone, accent)}>{row.word}</Text>}
        </Box>
      ))}
      {model.more !== null && (
        <Text key="more" color={MUTED} wrap="truncate-end">
          {model.more}
        </Text>
      )}
    </Box>
  )
}
