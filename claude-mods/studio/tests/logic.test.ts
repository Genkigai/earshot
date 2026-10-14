// studio's pure logic: checklists, the band's model, HTML to Markdown, image headers, addresses.

import { expect, test } from 'claude-code/testing'

import type { StudioJob } from '../types'
import {
  addTask,
  afterTool,
  beforeTool,
  bandModel,
  checklist,
  checklistWindow,
  endJob,
  htmlToMarkdown,
  imageAction,
  imageCells,
  imageFromBlock,
  imageLine,
  imageSize,
  isRealPrompt,
  jobName,
  needsReason,
  normalizeUrl,
  pageFrom,
  sendText,
  startJob,
  stepLabel,
  themesFrom,
  todosFromTaskList,
  todosFromTodoWrite,
  updateTask,
  CUSTOM_VALUE,
  afterDeny,
  claimIndex,
  customThemeJson,
  draftSeparator,
  themesFolderFrom,
  treeRows,
} from '../hooks/logic'
import { cells } from '../hooks/look-text'

const TODOS = [
  { content: 'Read the login code', status: 'completed', activeForm: 'Reading' },
  { content: 'Fix the token check', status: 'in_progress', activeForm: 'Fixing' },
  { content: 'Add a test', status: 'pending', activeForm: 'Adding' },
  { content: 'Run the suite', status: 'pending', activeForm: 'Running' },
]

function toBase64(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

function pngBytes(width: number, height: number): number[] {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 1, 2, 3, 4]
}

function jpegBytes(width: number, height: number): number[] {
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const sof = [0xff, 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return [0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]
}

function job(over: Partial<StudioJob> = {}): StudioJob {
  return { ...startJob('Fix the login bug', 1_000, null), ...over }
}

test('to-do input becomes checklist rows: done, working, Next, then Up next', async () => {
  const todos = todosFromTodoWrite(TODOS)
  expect(todos).toHaveLength(4)
  const rows = checklist(todos ?? [])
  expect(rows.map(row => [row.kind, row.word])).toEqual([
    ['done', 'Done'],
    ['working', 'Working'],
    ['next', 'Next'],
    ['later', 'Up next'],
  ])
  expect(rows[1]?.name).toBe('Fix the token check')
})

test('task tools build and update the same list', async () => {
  let list = addTask([], 'Write the parser', { task: { id: '7', subject: 'Write the parser' } })
  list = addTask(list, 'Test it', { task: { id: '8', subject: 'Test it' } })
  list = updateTask(list, { taskId: '7', status: 'in_progress' })
  expect(list.map(todo => todo.status)).toEqual(['in_progress', 'pending'])
  list = updateTask(list, { taskId: '8', status: 'deleted' })
  expect(list).toHaveLength(1)
  const listed = todosFromTaskList({ tasks: [{ id: '1', subject: 'One', status: 'completed', blockedBy: [] }] })
  expect(listed).toEqual([{ id: '1', name: 'One', status: 'completed' }])
})

test('the checklist window keeps the step in progress in view and counts the rest', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i < 5 ? 'completed' : i === 5 ? 'in_progress' : 'pending',
    activeForm: 'x',
  }))
  const rows = checklist(todosFromTodoWrite(many) ?? [])
  const { shown, more } = checklistWindow(rows, 7)
  expect(shown).toHaveLength(6)
  expect(more).toBe(4)
  expect(shown.some(row => row.kind === 'working')).toBe(true)
  const tight = checklistWindow(rows, 3)
  expect(tight.shown).toHaveLength(2)
  expect(tight.more).toBe(8)
})

test('band header states read as the spec words them', async () => {
  const working = bandModel(job({ step: 'Edit app.js' }), 73_000, 80, 10)
  expect(working?.header.left).toBe('Fix the login bug · 1m 12s')
  expect(working?.header.right).toBe('Edit app.js')

  const waiting = bandModel(job({ phase: 'needs', reason: 'permission to use Bash' }), 2_000, 80, 10)
  expect(waiting?.header.glyph).toBe('‖')
  expect(waiting?.header.left).toBe('Needs you · permission to use Bash')

  let stuck = job({ step: 'Bash npm test' })
  for (let i = 0; i < 3; i++) stuck = afterTool(beforeTool(stuck, 'Bash npm test'), true, 'Bash npm test')
  expect(stuck.phase).toBe('stuck')
  expect(bandModel(stuck, 2_000, 80, 10)?.header.left).toBe('The last 3 tool calls failed · Bash npm test')
  expect(stuck.step).toBe('Thinking')
  expect(afterTool(stuck, false).phase).toBe('working')
  const parallel = afterTool(beforeTool(job(), 'Read b.ts'), false, 'Read a.ts')
  expect(parallel.step).toBe('Read b.ts')

  const stopped = endJob(job(), 'aborted', 5_000)
  expect(bandModel(stopped, 9_000, 80, 10)?.header.left).toBe('Stopped · Fix the login bug · you pressed Esc')

  const done = endJob(job(), 'answer', 135_000)
  expect(bandModel(done, 999_000, 80, 10)?.header.left).toBe('All done · Fix the login bug · took 2m 14s')
  expect(bandModel({ ...done, phase: 'hidden' }, 0, 80, 10)).toBeNull()
})

test('band rows fit the columns and the rows given', async () => {
  const todos = todosFromTodoWrite(
    Array.from({ length: 12 }, (_, i) => ({
      content: `A rather long step name number ${i + 1} that will not fit`,
      status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending',
      activeForm: 'x',
    })),
  )
  for (const columns of [16, 32, 47, 80, 120]) {
    for (const maxRows of [1, 3, 8]) {
      const model = bandModel(job({ todos: todos ?? [], step: 'Bash npm run a-very-long-script-name --watch' }), 9_000, columns, maxRows)
      expect(model).not.toBeNull()
      if (model === null) continue
      const head = model.header
      expect(2 + cells(head.left) + head.gap + cells(head.right)).toBeLessThanOrEqual(columns)
      for (const row of model.rows) {
        const width = 2 + cells(row.name) + (row.meterFill + row.meterRest !== '' ? 2 + cells(row.meterFill + row.meterRest) : 0) + (row.word !== '' ? 2 + cells(row.word) : 0)
        expect(width).toBeLessThanOrEqual(columns)
      }
      expect(1 + model.rows.length + (model.more === null ? 0 : 1)).toBeLessThanOrEqual(maxRows)
    }
  }
})

test('job names, step labels and notification reasons', async () => {
  expect(jobName('Fix the login bug. Then run the tests')).toBe('Fix the login bug')
  expect(jobName('please refactor the payment service so that it handles retries and timeouts gracefully')).toBe(
    'Refactor the payment service so that it…',
  )
  expect(cells(jobName('x'.repeat(100)))).toBeLessThanOrEqual(40)
  expect(stepLabel('Edit', { file_path: '/repo/src/app.js' })).toBe('Edit app.js')
  expect(stepLabel('Bash', { command: 'npm test\necho done' })).toBe('Bash npm test')
  expect(stepLabel('mcp__github__create_issue', {})).toBe('github create_issue')
  expect(needsReason('Claude needs your permission to use Bash', 'permission_prompt')).toBe('permission to use Bash')
  expect(isRealPrompt('Fix /src/app.ts please', 'composer')).toBe(true)
  expect(isRealPrompt('/src/app.ts is broken', 'composer')).toBe(true)
  expect(isRealPrompt('/compact keep the plan', 'composer')).toBe(false)
  expect(isRealPrompt('look at this', 'task-notification')).toBe(false)
  expect(needsReason('Claude is waiting for your input', 'idle_prompt')).toBeNull()
})

test('HTML to Markdown: headings, links, code, lists, tables; scripts gone, entities decoded', async () => {
  const html = `<!doctype html><html><head><title>Guide &amp; Tips</title><style>p{color:red}</style>
    <script>document.write("<p>evil</p>")</script></head>
    <body><nav><a href="/home">Home</a></nav>
    <h1>Getting   started</h1>
    <p>Read the <a href="../api/index.html">API docs</a> &mdash; or <a href="https://other.org/x">elsewhere</a>.</p>
    <h3>Install</h3>
    <pre><code class="language-bash">pip install thing &amp;&amp; thing --help
  indented line</code></pre>
    <p>Use <code>thing.run()</code> &lt;now&gt; &#169; &#x2713;</p>
    <ul><li>One</li><li>Two<ul><li>Two point one</li></ul></li></ul>
    <ol><li>First</li><li>Second</li></ol>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
    <p><img src="x.png" alt="A chart"></p>
    <footer>Copyright</footer><noscript>enable js</noscript>
    </body></html>`
  const page = htmlToMarkdown(html, 'https://docs.example.com/guide/start.html')
  expect(page.title).toBe('Guide & Tips')
  const md = page.markdown
  expect(md).toContain('# Getting started')
  expect(md).toContain('### Install')
  expect(md).toContain('[API docs](https://docs.example.com/api/index.html)')
  expect(md).toContain('[elsewhere](https://other.org/x)')
  expect(md).toContain('— or')
  expect(md).toContain('```bash\npip install thing && thing --help\n  indented line\n```')
  expect(md).toContain('`thing.run()` <now> © ✓')
  expect(md).toContain('- One')
  expect(md).toContain('  - Two point one')
  expect(md).toContain('1. First')
  expect(md).toContain('2. Second')
  expect(md).toContain('| Name | Value |')
  expect(md).toContain('| --- | --- |')
  expect(md).toContain('| a | 1 |')
  expect(md).toContain('[image: A chart]')
  expect(md).not.toContain('evil')
  expect(md).not.toContain('color:red')
  expect(md).not.toContain('Home')
  expect(md).not.toContain('Copyright')
  expect(md).not.toContain('enable js')
})

test('a base tag sets what relative links resolve against', async () => {
  const page = htmlToMarkdown('<head><base href="https://cdn.example.org/docs/"></head><p><a href="intro.html">Intro</a></p>', 'https://example.org/')
  expect(page.markdown).toBe('[Intro](https://cdn.example.org/docs/intro.html)')
})

test('responses become pages: JSON fenced, plain text kept, errors in plain words', async () => {
  const json = pageFrom('https://api.example.com/v1/items', { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: '{"a":1}' })
  expect(json.ok && json.markdown).toBe('```json\n{\n  "a": 1\n}\n```')
  const text = pageFrom('https://example.com/notes.txt', { status: 200, ok: true, headers: { 'content-type': 'text/plain' }, text: 'hello\nworld' })
  expect(text.ok && text.markdown).toBe('hello\nworld')
  const missing = pageFrom('https://example.com/x', { status: 404, ok: false, headers: {}, text: '' })
  expect(missing.ok).toBe(false)
  expect(!missing.ok && missing.reason).toBe('the server answered 404')
  const binary = pageFrom('https://example.com/a.pdf', { status: 200, ok: true, headers: { 'content-type': 'application/pdf' }, text: '%PDF' })
  expect(!binary.ok && binary.reason).toBe('it is a application/pdf file, not a page')
  const sent = sendText('Guide', 'https://example.com', 'x'.repeat(7000))
  expect(sent.startsWith('From Guide (https://example.com):\n\n')).toBe(true)
  expect(sent.length).toBeLessThan(6100)
})

test('web addresses: bare hosts gain https, words are refused', async () => {
  expect(normalizeUrl('example.com/x')).toBe('https://example.com/x')
  expect(normalizeUrl('docs.python.org')).toBe('https://docs.python.org/')
  expect(normalizeUrl('http://example.com')).toBe('http://example.com/')
  expect(normalizeUrl('localhost:3000/a')).toBe('http://localhost:3000/a')
  expect(normalizeUrl('hello world')).toBeNull()
  expect(normalizeUrl('python')).toBeNull()
  expect(normalizeUrl('ftp://example.com')).toBeNull()
  expect(normalizeUrl('')).toBeNull()
})

test('image headers give PNG and JPEG sizes', async () => {
  expect(imageSize(new Uint8Array(pngBytes(1280, 720)))).toEqual({ kind: 'png', width: 1280, height: 720 })
  expect(imageSize(new Uint8Array(jpegBytes(640, 480)))).toEqual({ kind: 'jpeg', width: 640, height: 480 })
  expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull()
  const png = imageFromBlock({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: toBase64(pngBytes(1280, 720)) } }, 'shot.png', 5)
  expect(png?.png).not.toBeNull()
  expect(png !== null && imageLine(png)).toBe('shot.png · 1280×720 · 33 B')
  const jpeg = imageFromBlock({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toBase64(jpegBytes(640, 480)) } }, undefined, 5)
  expect(jpeg?.name).toBe('image.jpg')
  expect(jpeg?.png).toBeNull()
  expect(jpeg?.width).toBe(640)
})

test('the image pane only where it docks on the terminal and can be drawn', async () => {
  expect(imageAction({ isOn: true, hasTerminal: true, isFullscreen: true, canDraw: true })).toBe('pane')
  expect(imageAction({ isOn: true, hasTerminal: true, isFullscreen: false, canDraw: true })).toBe('status')
  expect(imageAction({ isOn: true, hasTerminal: true, isFullscreen: undefined, canDraw: true })).toBe('status')
  expect(imageAction({ isOn: true, hasTerminal: false, isFullscreen: true, canDraw: true })).toBe('status')
  expect(imageAction({ isOn: true, hasTerminal: true, isFullscreen: true, canDraw: false })).toBe('status')
  expect(imageAction({ isOn: false, hasTerminal: true, isFullscreen: true, canDraw: true })).toBe('none')
  expect(imageCells(1280, 720, 60, 40)).toEqual({ columns: 60, rows: 17 })
  expect(imageCells(720, 1280, 60, 20)).toEqual({ columns: 23, rows: 20 })
})

test('theme rows become skins with the custom entry last', async () => {
  const rows = [
    { key: 'theme', label: 'Theme', kind: 'choice' as const, value: 'dark', options: ['dark', 'light', 'dark-ansi'], provider: { plugin: 'engine', tier: 'core' as const }, isLocked: false },
  ]
  const found = themesFrom(rows)
  expect(found?.current).toBe('dark')
  expect(found?.themes.map(theme => theme.label)).toEqual(['Dark', 'Light', 'Dark ANSI', 'Gold & Slate (matches your mods)'])
  expect(found?.themes.at(-1)?.value).toBe(CUSTOM_VALUE)
  expect(themesFrom([])).toBeNull()
})

test('job names: escape sequences and control characters dropped, code fences skipped', async () => {
  expect(jobName('\u001b[31mTypeError\u001b[0m in parser fix it')).toBe('TypeError in parser fix it')
  expect(jobName('```ts\nconst x = 1\n```\nwhy does this fail')).toBe('Why does this fail')
  expect(jobName('```\nonly code\n```')).toBe('Only code')
  expect(stepLabel('Bash', { command: 'printf "\u001b[1mbold\u001b[0m"' })).toBe('Bash printf "bold"')
  expect(todosFromTodoWrite([{ content: 'Step\u0007 \u001b[32mone\u001b[0m', status: 'pending' }])?.[0]?.name).toBe('Step one')
  expect(needsReason('Claude needs your permission to use \u001b[1mBash\u001b[0m', 'permission_prompt')).toBe('permission to use Bash')
})

test('whose prompt starts a job: the person, or a plugin sending as them; a command never', async () => {
  expect(isRealPrompt('Make it faster', { kind: 'plugin', name: 'prompt-upgrade', asUser: true })).toBe(true)
  expect(isRealPrompt('Make it faster', { kind: 'plugin', name: 'workbench' })).toBe(false)
  expect(isRealPrompt('Make it faster', { kind: 'bridge' })).toBe(true)
  const isCommand = (name: string) => ['compact', 'clear'].includes(name)
  expect(isRealPrompt('/tmp is full, clean it', 'composer', isCommand)).toBe(true)
  expect(isRealPrompt('/compact keep the plan', 'composer', isCommand)).toBe(false)
  expect(isRealPrompt('   ', 'composer', isCommand)).toBe(false)
})

test('a starting turn claims the noted prompt with its text, in flight first', async () => {
  const notes = [
    { typed: 'Fix it', entered: 'Fix it', inFlight: false },
    { typed: 'Fix it', entered: null, inFlight: true },
    { typed: 'Shorten it', entered: 'Shorten it, briefly', inFlight: false },
  ]
  expect(claimIndex(notes, 'Fix it')).toBe(1)
  expect(claimIndex(notes, 'Shorten it, briefly')).toBe(2)
  expect(claimIndex(notes, 'Task 3 finished')).toBe(-1)
  expect(claimIndex(notes, '')).toBe(-1)
})

test('notifications: only the ones that wait on the person', async () => {
  expect(needsReason('Build finished in 3m', 'plugin_notification')).toBeNull()
  expect(needsReason('Claude is waiting for your input', 'idle_prompt')).toBeNull()
  expect(needsReason('A helper needs your input', 'agent_needs_input')).toBe('A helper needs your input')
  expect(needsReason('Claude needs your permission to use Bash', 'worker_permission_prompt')).toBe('permission to use Bash')
})

test('a refused tool call keeps the Stuck count and ends a wait', async () => {
  const twice = afterTool(afterTool(job({ step: 'Bash x' }), true, 'Bash x'), true, 'Bash x')
  const denied = afterDeny(beforeTool(twice, 'Bash rm'), 'Bash rm')
  expect(denied.failures).toBe(2)
  expect(denied.step).toBe('Thinking')
  expect(afterTool(beforeTool(denied, 'Bash y'), true, 'Bash y').phase).toBe('stuck')
  const waiting = afterDeny({ ...job(), phase: 'needs', reason: 'permission to use Bash', step: 'Bash rm' }, 'Bash rm')
  expect(waiting.phase).toBe('working')
  expect(waiting.reason).toBe('')
})

test('HTML: a head left open, a quoted ">" in an attribute, a heading inside a link', async () => {
  const open = htmlToMarkdown('<head><title>Docs – Home</title><meta charset="utf-8"><body><h1>Hello</h1></body>', 'https://ex.com/')
  expect(open.title).toBe('Docs – Home')
  expect(open.markdown).toBe('# Hello')
  const quoted = htmlToMarkdown('<p><a title="a>b" href="/x">x</a> after</p>', 'https://ex.com/')
  expect(quoted.markdown).toBe('[x](https://ex.com/x) after')
  const card = htmlToMarkdown('<a href="/post"><h2>Post title</h2></a><p>Body.</p>', 'https://ex.com/')
  expect(card.markdown).toBe('## [Post title](https://ex.com/post)\n\nBody.')
  const stray = htmlToMarkdown('<p class=a"b>Text</p><script>evil()</script>', 'https://ex.com/')
  expect(stray.markdown).toBe('Text')
})

test('a page with no <title> takes its first heading as plain text, link markup gone', async () => {
  const card = htmlToMarkdown('<body><a href="/p"><h2>Post title</h2></a><p>x</p></body>', 'https://ex.com/')
  expect(card.title).toBe('Post title')
  expect(card.markdown).toBe('## [Post title](https://ex.com/p)\n\nx')
  const inner = htmlToMarkdown('<h1><a href="/a">Docs</a> and <a href="/b">[beta] notes</a></h1>', 'https://ex.com/')
  expect(inner.title).toBe('Docs and [beta] notes')
  expect(htmlToMarkdown('<p>No heading here.</p>', 'https://ex.com/').title).toBe('ex.com')
})

test('sent pages start on a new paragraph after a draft', async () => {
  expect(draftSeparator('')).toBe('')
  expect(draftSeparator('  ')).toBe('')
  expect(draftSeparator('summarize this')).toBe('\n\n')
  expect(draftSeparator('summarize this\n')).toBe('\n')
  expect(draftSeparator('summarize this\n\n')).toBe('')
})

test('the themes folder: HOME or a full CLAUDE_CONFIG_DIR; anything relative is refused', async () => {
  expect(themesFolderFrom('/home/dev', '')).toEqual({ path: '/home/dev/.claude/themes', shown: '~/.claude/themes' })
  expect(themesFolderFrom('/home/dev', '/srv/claude/')).toEqual({ path: '/srv/claude/themes', shown: '/srv/claude/themes' })
  expect('error' in themesFolderFrom('/home/dev', '~/.claude-work')).toBe(true)
  expect('error' in themesFolderFrom('/home/dev', 'config')).toBe(true)
  expect('error' in themesFolderFrom('', '')).toBe(true)
})

test('Gold & Slate carries the whole palette, slate included', async () => {
  const theme = JSON.parse(customThemeJson()) as { overrides: Record<string, string> }
  const colours = Object.values(theme.overrides)
  for (const hex of ['#F2C46D', '#262B33', '#7D8590', '#E6EDF3', '#3DD68C', '#E3B341']) expect(colours).toContain(hex)
})

test('tree rows: a column sums, a row takes its tallest, borders and margins count, the engine node none', async () => {
  const text = (value: string) => ({ type: 'Text', props: {}, children: [value] })
  expect(treeRows({ type: 'Box', props: { flexDirection: 'column' }, children: [text('a'), text('b\nc')] })).toBe(3)
  expect(treeRows({ type: 'Box', props: {}, children: [text('a'), text('b\nc')] })).toBe(2)
  expect(treeRows({ type: 'Box', props: { flexDirection: 'column', borderStyle: 'round', marginTop: 1 }, children: [text('a')] })).toBe(4)
  expect(treeRows({ type: 'engine', ref: 0 })).toBe(0)
  expect(treeRows({ type: 'Box', props: { display: 'none' }, children: [text('a')] })).toBe(0)
})
