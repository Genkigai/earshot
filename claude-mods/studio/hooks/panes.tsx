// The three panes: SKINS, IMAGE and BROWSE. Each draws from the values it is
// handed and the presses it is given; nothing here reads or writes state.

import type { Elements, RenderElement, UiPressArgument } from 'claude-code'

import type { StudioAccent, StudioBrowse, StudioImage, StudioSettings, StudioSkins, StudioTone } from '../types'
import { toneColor } from './band'
import { accentChip, choiceChipIn, heading, line, quietButton, slateChip, titleBarIn } from './look'
import type { Kit } from './look'
import { AMBER, GOLD, GREEN, MUTED, SLATE, TEXT, fit, pad } from './look-text'
import {
  ACCENTS,
  ACCENT_ORDER,
  CUSTOM_VALUE,
  formatBytes,
  imageCells,
  imageLine,
  themeLabel,
} from './logic'

type ImageElement = Elements['terminal']['Image']
export type PageKit = Kit & Pick<Elements['terminal'], 'Markdown' | 'Link'>

function toneOf(tone: StudioTone, accent: string): string {
  return toneColor(tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'muted', accent)
}

// ---------------------------------------------------------------------------
// SKINS

export type SkinsActions = {
  use: (value: string) => void
  accent: (accent: StudioAccent) => void
  openTheme: () => void
  close: () => void
}

/** Built-in themes preview in theme keys (they follow the theme in use); Gold & Slate in its own colours. */
const KEY_SWATCH = ['claude', 'success', 'warning', 'error', 'permission'] as const
const GOLD_SWATCH = [GOLD, GREEN, AMBER, MUTED, TEXT] as const

export function drawSkins(
  kit: Kit,
  skins: StudioSkins,
  settings: StudioSettings,
  columns: number,
  actions: SkinsActions,
): RenderElement {
  const { Box, Text } = kit
  const accent = ACCENTS[settings.accent].hex
  const swatchWidth = columns >= 40 ? 5 : columns >= 28 ? 3 : 0
  const chipWidth = 5
  const labelWidth = Math.max(1, columns - chipWidth - 1 - (swatchWidth > 0 ? swatchWidth + 1 : 0))
  const current = skins.current
  return (
    <Box flexDirection="column" width={columns}>
      {titleBarIn(kit, 'Skins', current === '' ? '' : `now: ${themeLabel(current)}`, columns, accent)}
      {heading(kit, 'Themes', columns, 'themes')}
      {skins.themes.length === 0 && line(kit, 'This build lists no theme row in /config.', columns, AMBER, 'no-themes')}
      {skins.themes.map(theme => {
        const isCurrent = theme.value === current
        const swatch = theme.value === CUSTOM_VALUE ? GOLD_SWATCH : KEY_SWATCH
        return (
          <Box key={`theme-${theme.value}`} flexDirection="row" width={columns}>
            <Text color={isCurrent ? TEXT : MUTED} bold={isCurrent} wrap="truncate-end">
              {pad(theme.label, labelWidth)}
            </Text>
            {swatchWidth > 0 && <Text>{' '}</Text>}
            {swatch.slice(0, swatchWidth).map((color, index) => (
              <Text key={`sw-${index}`} color={color}>
                {'■'}
              </Text>
            ))}
            <Text>{' '}</Text>
            {isCurrent
              ? accentChip(kit, `use:${theme.value}`, 'Use', () => actions.use(theme.value), accent)
              : slateChip(kit, `use:${theme.value}`, 'Use', () => actions.use(theme.value))}
          </Box>
        )
      })}
      {line(kit, 'Swatches draw in the theme in use. Use switches at once.', columns, MUTED, 'hint')}
      {skins.note !== '' &&
        skins.note.split('\n').map((part, index) => line(kit, part, columns, toneOf(skins.tone, accent), `note-${index}`))}
      {skins.canOpenTheme && (
        <Box key="open-theme-row" flexDirection="row" width={columns}>
          {slateChip(kit, 'open-theme', 'Open /theme', actions.openTheme)}
        </Box>
      )}
      {heading(kit, 'Mods accent', columns, 'accent')}
      <Box key="accents" flexDirection="row" flexWrap="wrap" columnGap={1} width={columns}>
        {ACCENT_ORDER.map(name =>
          choiceChipIn(kit, `accent:${name}`, ACCENTS[name].label, settings.accent === name, () => actions.accent(name), ACCENTS[name].hex),
        )}
      </Box>
      <Box key="foot" flexDirection="row" width={columns} marginTop={1}>
        {quietButton(kit, 'close', 'Close', actions.close)}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// IMAGE

function typeName(mediaType: string): string {
  const sub = mediaType.split('/')[1] ?? mediaType
  return sub === 'jpeg' ? 'JPEG' : sub.toUpperCase()
}

export function drawImagePane(
  kit: Kit,
  ImageEl: ImageElement | null,
  image: StudioImage | null,
  columns: number,
  bodyRows: number,
  accent: string,
  close: () => void,
): RenderElement {
  const { Box, Text } = kit
  if (image === null) {
    return (
      <Box flexDirection="column" width={columns}>
        {titleBarIn(kit, 'Image', '', columns, accent)}
        {line(kit, 'No image yet. Paste one into a prompt.', columns, MUTED, 'empty')}
        <Box key="foot" flexDirection="row" width={columns} marginTop={1}>
          {quietButton(kit, 'close', 'Close', close)}
        </Box>
      </Box>
    )
  }
  const alt = fit(imageLine(image), Math.max(1, columns))
  const box = imageCells(image.width, image.height, columns, Math.max(3, bodyRows - 9))
  const pixels = image.width !== null && image.height !== null ? `${image.width}×${image.height}` : 'unknown'
  const why =
    ImageEl === null
      ? 'This surface shows the picture in the conversation itself.'
      : image.mediaType !== 'image/png'
        ? 'The terminal draws PNG pictures only; here are the details.'
        : 'Too large for the terminal to draw (2 MB at most).'
  const labelWidth = 8
  const detail = (key: string, label: string, value: string) => (
    <Box key={key} flexDirection="row" width={columns}>
      <Text color={MUTED}>{pad(label, Math.min(labelWidth, columns))}</Text>
      {columns > labelWidth && (
        <Text color={TEXT} wrap="truncate-end">
          {fit(value, columns - labelWidth)}
        </Text>
      )}
    </Box>
  )
  return (
    <Box flexDirection="column" width={columns}>
      {titleBarIn(kit, 'Image', image.name, columns, accent)}
      {ImageEl !== null && image.png !== null ? (
        <Box key="picture-row" flexDirection="row" width={columns} marginTop={1}>
          <ImageEl key="picture" source={{ png: image.png }} columns={box.columns} rows={box.rows} alt={alt} />
        </Box>
      ) : (
        line(kit, why, columns, MUTED, 'why')
      )}
      {heading(kit, 'Details', columns, 'details')}
      {detail('d-name', 'Name', image.name)}
      {detail('d-type', 'Type', typeName(image.mediaType))}
      {detail('d-pixels', 'Pixels', pixels)}
      {detail('d-size', 'Size', image.bytes > 0 ? formatBytes(image.bytes) : 'unknown')}
      <Box key="foot" flexDirection="row" width={columns} marginTop={1}>
        {quietButton(kit, 'close', 'Close', close)}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// BROWSE

export type BrowseActions = {
  back: () => void
  send: () => void
  copy: (press: UiPressArgument) => void
  retry: () => void
  close: () => void
  link: (href: string) => void
}

export function drawBrowse(
  kit: PageKit,
  browse: StudioBrowse,
  columns: number,
  accent: string,
  actions: BrowseActions,
): RenderElement {
  const { Box, Text, Button, Markdown, Link } = kit
  const host = browse.host
  const title = browse.phase === 'ready' && browse.title !== '' ? browse.title : host === '' ? 'Browse' : host
  const isWide = columns >= 50
  const canGoBack = browse.history.length > 0
  const foot = (
    <Box key="close-row" flexDirection="row" width={columns}>
      {quietButton(kit, 'close', 'Close', actions.close)}
    </Box>
  )
  let body: RenderElement
  if (browse.phase === 'loading') {
    body = (
      <Box key="loading" flexDirection="column" width={columns}>
        {line(kit, `Loading ${host}…`, columns, MUTED, 'loading-line')}
        {foot}
      </Box>
    )
  } else if (browse.phase === 'error') {
    const inner = Math.max(1, columns - 4)
    body = (
      <Box key="error" flexDirection="column" width={columns} borderStyle="round" borderColor={AMBER} paddingX={1}>
        <Text color={AMBER} wrap="truncate-end">
          {fit(`Couldn't load ${host}: ${browse.error}.`, inner)}
        </Text>
        <Box key="error-actions" flexDirection="row" columnGap={1} width={inner}>
          {accentChip(kit, 'retry', 'Try again', actions.retry, accent)}
          {quietButton(kit, 'close', 'Close', actions.close)}
        </Box>
      </Box>
    )
  } else if (browse.phase === 'ready') {
    body = (
      <Box key="page-box" flexDirection="column" width={columns}>
        <Markdown key="page" text={browse.markdown} onLinkPress={link => actions.link(link.href)} />
      </Box>
    )
  } else {
    body = (
      <Box key="idle" flexDirection="column" width={columns}>
        {line(kit, 'Nothing open. Try /browse docs.python.org.', columns, MUTED, 'idle-line')}
        {foot}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={columns}>
      {titleBarIn(kit, title, host, columns, accent, false)}
      {browse.phase === 'ready' && (
        <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={1} width={columns}>
          {canGoBack && slateChip(kit, 'back', isWide ? '‹ Back' : '‹', actions.back)}
          {accentChip(kit, 'send', isWide ? 'Send to Claude' : 'Send', actions.send, accent)}
          <Button key="copy" plain onPress={actions.copy}>
            <Text backgroundColor={SLATE} color={TEXT}>
              {' Copy '}
            </Text>
          </Button>
          {browse.url !== '' && <Link key="open-link" href={browse.url} label={isWide ? 'Open link' : 'Open'} />}
          {quietButton(kit, 'close', 'Close', actions.close)}
        </Box>
      )}
      {browse.note !== '' && line(kit, browse.note, columns, toneOf(browse.tone, accent), 'note')}
      {body}
    </Box>
  )
}
