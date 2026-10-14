// A small world beneath the plugin for tests: a file system in memory, a process runner that
// knows mkdir/mv/rm/du/find, and answers for every engine call safety-net makes.

import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement, RenderNode } from 'claude-code'

import { baseName, dirName, isInside, joinPath, lex } from '../hooks/logic'

export type Out = { exitCode?: number; stdout?: string; stderr?: string }

export type WorldOptions = {
  cwd?: string
  root?: string
  home?: string
  /** path → file text (string) or size in bytes (number); a path ending in "/" is an empty folder. */
  files?: Record<string, string | number>
  /** Answers a process before the built-in fakes; undefined falls through. */
  run?: (argv: readonly string[], cwd: string) => Out | undefined
  /** What the person picks in safety-net's own question. */
  answer?: string
  /** The test registers its own Bash hook (one that asks the permission check first). */
  checkInBash?: boolean
  /** $.store.set refuses, as a full disk would. */
  failStore?: boolean
  /** HOME can't be read. */
  failHome?: boolean
  /** The engine's own permission verdict for a Bash command (default: allow). */
  verdictFor?: (command: string) => { decision: 'allow' | 'ask' | 'deny'; reason?: string }
  surfaces?: readonly 'terminal'[]
  now?: number
  store?: Record<string, unknown>
  modelReply?: string | null
  /** Where a path really lands when stat resolves it (a link elsewhere); default: the path itself. */
  realPaths?: Record<string, string>
  /** The surface has no clipboard, as a remote surface has none yet. */
  copyFails?: boolean
}

type Node = { kind: 'file' | 'dir'; size: number; text: string }

export type World = {
  nodes: Map<string, Node>
  log: string[]
  bash: string[]
  checks: { decision: string; reason?: string }[]
  asked: string[]
  statuses: (string | undefined)[]
  toasts: string[]
  logs: string[]
  opened: string[]
  copied: string[]
  clock: MockClock
  has: (path: string) => boolean
  text: (path: string) => string | undefined
  children: (dir: string) => string[]
  /** Runs a Bash command line the way the fakes know: mkdir, mv, rm joined by && or ;. */
  exec: (command: string) => void
}

function result(o: Out): ProcessRunResult {
  return { exitCode: o.exitCode ?? 0, stdout: o.stdout ?? '', stderr: o.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

export function world(on: On, opts: WorldOptions = {}): World {
  const cwd = opts.cwd ?? '/work/app'
  const root = opts.root ?? cwd
  const home = opts.home ?? '/home/me'
  const nodes = new Map<string, Node>()
  const w: World = {
    nodes,
    log: [],
    bash: [],
    checks: [],
    asked: [],
    statuses: [],
    toasts: [],
    logs: [],
    opened: [],
    copied: [],
    clock: mock.clock(on, { now: opts.now ?? Date.UTC(2026, 9, 14, 12, 0, 0) }),
    has: p => nodes.has(p),
    text: p => nodes.get(p)?.text,
    children: dir => [...nodes.keys()].filter(k => dirName(k) === dir && k !== dir).map(k => baseName(k)).sort(),
    exec: command => execBash(command),
  }
  const mkdirp = (path: string) => {
    let p = path
    const chain: string[] = []
    while (p !== '/' && !nodes.has(p)) {
      chain.push(p)
      p = dirName(p)
    }
    for (const c of chain) nodes.set(c, { kind: 'dir', size: 0, text: '' })
  }
  const addFile = (path: string, content: string | number) => {
    mkdirp(dirName(path))
    if (typeof content === 'number') nodes.set(path, { kind: 'file', size: content, text: '' })
    else nodes.set(path, { kind: 'file', size: content.length, text: content })
  }
  const under = (path: string) => [...nodes.keys()].filter(k => k === path || isInside(k, path))
  const remove = (path: string) => {
    for (const k of under(path)) nodes.delete(k)
  }
  const move = (from: string, to: string): boolean => {
    if (!nodes.has(from) || !nodes.has(dirName(to)) || nodes.has(to)) return false
    for (const k of under(from)) {
      const n = nodes.get(k)!
      nodes.delete(k)
      nodes.set(to + k.slice(from.length), n)
    }
    return true
  }
  const bytesUnder = (path: string) => under(path).reduce((s, k) => s + (nodes.get(k)?.size ?? 0), 0)
  mkdirp(cwd)
  mkdirp(root)
  mkdirp(home)
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    if (path.endsWith('/')) mkdirp(path.slice(0, -1))
    else addFile(path, content)
  }

  const fakeRun = (argv: readonly string[], at: string): Out => {
    const abs = (p: string) => joinPath(at, p)
    const operands = argv.slice(1).filter(a => a !== '--' && !/^-[a-zA-Z]+$/.test(a))
    switch (argv[0]) {
      case 'mkdir':
        for (const p of operands) mkdirp(abs(p))
        return {}
      case 'mv': {
        const [a, b] = operands
        if (a === undefined || b === undefined) return { exitCode: 1 }
        return move(abs(a), abs(b)) ? {} : { exitCode: 1, stderr: 'mv: cannot move' }
      }
      case 'rm':
        for (const p of operands) remove(abs(p))
        return {}
      case 'du': {
        const kb = (p: string) => Math.ceil(bytesUnder(abs(p)) / 1024)
        if (argv.includes('-skc')) {
          const total = operands.reduce((s, p) => s + kb(p), 0)
          return { stdout: operands.map(p => `${kb(p)}\t${p}`).join('\n') + `\n${total}\ttotal\n` }
        }
        return { stdout: `${kb(operands[0] ?? '.')}\t${operands[0] ?? '.'}\n` }
      }
      case 'find': {
        const start = abs(argv[1] ?? '.')
        if (!nodes.has(start)) return { exitCode: 1, stderr: 'find: no such file' }
        const nameAt = argv.indexOf('-name')
        const pattern = nameAt < 0 ? null : globToRegExp(argv[nameAt + 1] ?? '*')
        const onlyFiles = argv.includes('-type') && argv[argv.indexOf('-type') + 1] === 'f'
        const hits = under(start).filter(k => (!onlyFiles || nodes.get(k)?.kind === 'file') && (pattern === null || pattern.test(baseName(k))))
        const shown = hits.map(k => (argv[1] !== undefined && !argv[1].startsWith('/') ? joinPath('.', k.slice(at.length + 1)) : k))
        return { stdout: shown.join('\n') + (shown.length > 0 ? '\n' : '') }
      }
      case 'claude':
        return { stdout: '√ Validation passed\n' }
      default:
        return {}
    }
  }

  const execBash = (command: string) => {
    const { tokens } = lex(command)
    let words: string[] = []
    const flush = () => {
      if (words.length > 0) fakeRun(words, cwd)
      words = []
    }
    for (const t of tokens) {
      if (t.t === 'word') words.push(t.w.text)
      else flush()
    }
    flush()
  }

  if (opts.failHome === true) on('env.get', () => ({ deny: 'the environment cannot be read' }))
  else mock.env(on, { HOME: home })
  if (opts.failStore === true) {
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ deny: 'the disk is full' }))
    on('store.keys', () => ({ value: [] }))
    on('store.delete', () => ({ value: undefined }))
  } else {
    mock.store(on, opts.store ?? {})
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: root }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.Stop', () => ({}))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.copy', ($, e) => {
    if (opts.copyFails === true) return { value: { isCopied: false, reason: 'no-clipboard' } }
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('model.complete', () =>
    opts.modelReply === undefined || opts.modelReply === null
      ? { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
      : { value: { isAnswered: true, text: opts.modelReply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  )
  on('fs.stat', ($, e) => {
    const p = joinPath(cwd, e.path)
    const n = nodes.get(p)
    if (n === undefined) return { deny: `ENOENT: ${p}` }
    return { value: { kind: n.kind, size: n.size, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: opts.realPaths?.[p] ?? p } : {}) } }
  })
  on('fs.list', ($, e) => {
    const p = joinPath(cwd, e.path)
    if (nodes.get(p)?.kind !== 'dir') return { deny: `ENOENT: ${p}` }
    return {
      value: w.children(p).map(name => {
        const n = nodes.get(`${p === '/' ? '' : p}/${name}`)!
        return { name, kind: n.kind, size: n.size, mtimeMs: 0, isLink: false }
      }),
    }
  })
  on('fs.read', ($, e) => {
    const n = nodes.get(joinPath(cwd, e.path))
    return n?.kind === 'file' ? { value: n.text } : { deny: 'ENOENT' }
  })
  on('fs.write', ($, e) => {
    const p = joinPath(cwd, e.path)
    addFile(p, e.text)
    w.log.push(`write ${p}`)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: nodes.has(joinPath(cwd, e.path)) }))
  on('process.run', ($, e) => {
    const at = e.init?.cwd === undefined ? cwd : joinPath(cwd, e.init.cwd)
    w.log.push(`run ${e.argv.join(' ')}`)
    return { value: result(opts.run?.(e.argv, at) ?? fakeRun(e.argv, at)) }
  })
  on('tool.check', ($, e) => {
    const command = (e.input as { command?: unknown }).command
    return opts.verdictFor !== undefined && typeof command === 'string' ? opts.verdictFor(command) : { decision: 'allow' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]?.question ?? ''
    w.asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: opts.answer ?? 'Run it' } } } as never
  })
  if (opts.checkInBash !== true) {
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      w.bash.push(e.command)
      w.log.push(`bash ${e.command}`)
      execBash(e.command)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
  }
  return w
}

export const PANE_PROPS = (columns: number) => ({ title: 'x', isFocused: false, bodyColumns: columns, placement: 'dock' }) as never

export const RUN = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as never

function cells(text: string): number {
  return Array.from(text).length
}

/** The widest row a drawn tree takes, in cells: rows add up, columns take their widest child. */
export function widthOf(node: RenderNode | undefined): number {
  if (node === undefined) return 0
  if (typeof node === 'string') return cells(node)
  const el = node as RenderElement & { props?: Record<string, unknown>; children?: RenderNode[] }
  const props = (el.props ?? {}) as Record<string, unknown>
  const kids = (el.children ?? []) as RenderNode[]
  const num = (k: string) => (typeof props[k] === 'number' ? (props[k] as number) : 0)
  if (props.display === 'none') return 0
  if (el.type === 'Text') return kids.reduce((s: number, c) => s + widthOf(c), 0)
  if (el.type === 'Button') {
    const inner = kids.length > 0 ? kids.reduce((s: number, c) => s + widthOf(c), 0) : cells(String(props.label ?? ''))
    return inner + (props.plain === true ? 0 : 4)
  }
  if (el.type !== 'Box') return 0
  const pad = num('padding') * 2 + num('paddingX') * 2 + num('paddingLeft') + num('paddingRight') + (typeof props.borderStyle === 'string' ? 2 : 0)
  const margin = (c: RenderNode) => {
    if (typeof c === 'string') return 0
    const p = ((c as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>
    const m = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
    return m('margin') * 2 + m('marginX') * 2 + m('marginLeft') + m('marginRight')
  }
  const isRow = props.flexDirection === 'row' || props.flexDirection === 'row-reverse'
  if (isRow) {
    const gap = num('gap') || num('columnGap')
    return pad + kids.reduce((s: number, c) => s + widthOf(c) + margin(c), 0) + gap * Math.max(0, kids.length - 1)
  }
  return pad + kids.reduce((m: number, c) => Math.max(m, widthOf(c) + margin(c)), 0)
}
