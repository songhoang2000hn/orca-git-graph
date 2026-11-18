// orca-git-graph panel: an isolated HTML frame that draws the commit graph in SVG beside the
// commit list. It talks to the worker with orca.plugin.request and refreshes when the worker
// posts `repo.changed` or Orca reports `workspace.changed`. Git actions live in actions.ts.
import { edgePath, layoutGraph, type Layout } from '../layout.ts'
import { formatCommitDate } from '../format.ts'
import { clampColumnWidth, resolveColumnWidths, type ColumnName } from '../columns.ts'
import { findCommitHashes } from '../search.ts'
import type {
  Candidate,
  Commit,
  CommitDetails,
  DetailsLoad,
  FileChange,
  FileDiff,
  FileDiffLoad,
  GraphLoad,
  Ref,
  RepoInfo,
  RepoStatus,
  StatusLoad,
  WorktreeChanges,
  WorktreeLoad
} from '../types.ts'
import { checkoutRef, commitMenu, createToolbar, initActions, refMenu, renderBanner } from './actions.ts'
import { el, icon, ICONS, moving, svg } from './dom.ts'
import { orca } from './frame.ts'
import { openDialog } from './overlay.ts'

const PAGE = 200
const ROW_H = 24
const COL_W = 14
const PAD_X = 10
const NODE_R = 4
const LANE_COLORS = 8
const PINS_KEY = 'orca-git-graph.pins'
const MAX_PINS = 200
const SSH_KEY = 'orca-git-graph.ssh'
// Same rule as the worker's: an ssh alias or [user@]host[:port], never an option.
const SSH_TARGET = /^(?!-)[A-Za-z0-9._@%+\[\]:-]{1,255}$/

const $ = <T extends Element>(id: string) => document.getElementById(id) as unknown as T
const repoEl = $<HTMLElement>('repo')
const branchEl = $<HTMLElement>('branch')
const refreshEl = $<HTMLButtonElement>('refresh')
const switchRepoEl = $<HTMLButtonElement>('switch-repo')
const sshHostEl = $<HTMLButtonElement>('ssh-host')
const searchEl = $<HTMLButtonElement>('search')
const findEl = $<HTMLElement>('find')
const findInputEl = $<HTMLInputElement>('find-input')
const findCountEl = $<HTMLElement>('find-count')
const findPreviousEl = $<HTMLButtonElement>('find-previous')
const findNextEl = $<HTMLButtonElement>('find-next')
const findCloseEl = $<HTMLButtonElement>('find-close')
const messageEl = $<HTMLElement>('message')
const listEl = $<HTMLElement>('list')
const commitHeaderEl = $<HTMLElement>('commit-header')
const graphEl = $<SVGSVGElement>('graph')
const rowsEl = $<HTMLElement>('rows')
const moreEl = $<HTMLElement>('more')
const detailsEl = $<HTMLElement>('details')
const bannerEl = $<HTMLElement>('banner')

let repo: RepoInfo | null = null
/** Commits loaded so far, in `git log` order; paging counts these. */
let commits: Commit[] = []
/** What the list shows: the uncommitted-changes row, when there is one, then `commits`. */
let rows: Commit[] = []
let hasMore = false
let selected: string | null = null
let seq = 0
let loading = false
let loadingMore = false
let findMatches: string[] = []
let findIndex = -1
const COLUMN_KEY = 'finline-git-graph.columns'
const columnWidths: Partial<Record<ColumnName, number>> = (() => {
  try { return JSON.parse(localStorage.getItem(COLUMN_KEY) ?? '{}') ?? {} } catch { return {} }
})()

function resolvedColumnWidths(): Record<ColumnName, number> {
  return resolveColumnWidths(listEl.clientWidth, columnWidths, graphWidth)
}
function graphColumnWidth(): number { return resolvedColumnWidths().graph }
function applyColumns(): void {
  const values = resolvedColumnWidths()
  for (const [name, width] of Object.entries(values)) listEl.style.setProperty(`--${name}-col`, `${width}px`)
}
function saveColumn(column: ColumnName, width: number): void {
  columnWidths[column] = clampColumnWidth(column, width, graphWidth)
  try { localStorage.setItem(COLUMN_KEY, JSON.stringify(columnWidths)) } catch {}
  applyColumns()
  drawGraph()
}

// ---- Pinning: which repo a workspace is, when name + branch match several ---------------------
// readContext has no workspace id, but terminal ids are unique, so the pin is keyed by them.

function readPins(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

function writePins(pins: Record<string, string>): void {
  const keys = Object.keys(pins)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PINS))) delete pins[key]
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins))
  } catch {
    // Storage unavailable: the person picks again next time.
  }
}

async function terminalIds(): Promise<string[]> {
  try {
    const context = await orca.host.call('workspace.readContext', {})
    return context ? context.terminals.map((t: { id: string }) => t.id) : []
  } catch {
    return []
  }
}

let sessionPick: string | null = null

async function pinnedPath(): Promise<string | null> {
  const pins = readPins()
  for (const id of await terminalIds()) if (pins[id]) return pins[id]
  return sessionPick
}

async function pin(path: string): Promise<void> {
  const pins = readPins()
  for (const id of await terminalIds()) pins[id] = path
  writePins(pins)
}

/** True when the shown repo came from a pick, so it can be picked again. */
let pickedRepo = false

/** Forgets this workspace's pick; the worker answers `ambiguous` again and the picker returns. */
async function unpin(): Promise<void> {
  const pins = readPins()
  for (const id of await terminalIds()) delete pins[id]
  writePins(pins)
  sessionPick = null
  await refresh()
}

// ---- SSH hosts: how to reach each one with ssh ---------------------------------------------
// Orca names a remote host only by an id (`ssh:<connection>`), so the person tells orca-git-graph once
// which ssh destination reaches it. Kept per host id, for every workspace on that host.

function readSshTargets(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(SSH_KEY) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function writeSshTarget(hostId: string, target: string): void {
  const targets = readSshTargets()
  targets[hostId] = target
  try {
    localStorage.setItem(SSH_KEY, JSON.stringify(targets))
  } catch {
    // Storage unavailable: asked again next time.
  }
}

/** Kept in memory too, so a frame without storage still works until it reloads. */
const sessionSshTargets: Record<string, string> = {}

async function askSshTarget(hostId: string, current?: string): Promise<void> {
  const answer = await openDialog({
    title: 'Reach this SSH host',
    text:
      'The ssh destination for this host, as you would type it after ssh in a terminal on this computer: an alias from ~/.ssh/config or user@host. orca-git-graph runs git there without prompts, so the login must work with a key or the ssh agent.',
    fields: [
      {
        kind: 'text',
        id: 'target',
        label: 'ssh destination',
        value: current ?? '',
        placeholder: 'my-server or me@example.com',
        validate: (value) => (SSH_TARGET.test(value.trim()) ? null : 'Use an alias or user@host, without spaces or options.')
      }
    ],
    preview: (values) => (SSH_TARGET.test(String(values.target ?? '').trim()) ? `ssh ${String(values.target).trim()} git --version` : null),
    confirm: 'Connect'
  })
  if (!answer) return
  const target = String(answer.target).trim()
  sessionSshTargets[hostId] = target
  writeSshTarget(hostId, target)
  await refresh()
}

function showSshSetup(title: string, text: string, hostId: string, current?: string): void {
  showMessage(title, text, current ? 'danger' : 'warning')
  const button = el('button', '', current ? 'Change the ssh destination…' : 'Set the ssh destination…')
  button.type = 'button'
  if (current) button.append(el('small', '', current))
  button.addEventListener('click', () => void askSshTarget(hostId, current))
  messageEl.append(button)
}

// ---- Loading -------------------------------------------------------------------------------

async function request(input: { limit: number; skip: number }): Promise<GraphLoad> {
  const preferred = await pinnedPath()
  const sshTargets = { ...readSshTargets(), ...sessionSshTargets }
  // The host refuses keys whose value is undefined, so add optional keys only when set.
  return orca.plugin.request('graph.load', {
    ...input,
    ...(preferred ? { preferredPath: preferred } : {}),
    ...(Object.keys(sshTargets).length > 0 ? { sshTargets } : {})
  })
}

/** Reloads from the top, keeping as many commits as are already shown. */
async function refresh(): Promise<void> {
  const mine = ++seq
  setLoading(true)
  try {
    const result = await request({ skip: 0, limit: Math.max(PAGE, commits.length) })
    if (mine !== seq) return
    await apply(result, false)
  } catch (error) {
    if (mine === seq) showError(error)
  } finally {
    if (mine === seq) setLoading(false)
  }
}

async function loadMore(): Promise<void> {
  if (!hasMore || loading || loadingMore) return
  const mine = seq
  loadingMore = true
  moreEl.hidden = false
  try {
    const result = await request({ skip: commits.length, limit: PAGE })
    if (mine !== seq) return
    await apply(result, true)
  } catch (error) {
    if (mine === seq) showError(error)
  } finally {
    loadingMore = false
    moreEl.hidden = !hasMore
  }
}

async function apply(result: GraphLoad, append: boolean): Promise<void> {
  pickedRepo = result.ok && result.resolvedBy.startsWith('pinned')
  if (!result.ok) {
    repo = null
    commits = []
    hasMore = false
    detailsCache.clear()
    select(null)
    renderList()
    setStatus(null)
    if (result.reason === 'ambiguous') showPicker(result.message, result.candidates)
    else if (result.reason === 'ssh-target') showSshSetup('Workspace on an SSH host', result.message, result.hostId)
    else if (result.reason === 'ssh-failed') {
      showSshSetup('Could not reach the SSH host', result.message, result.hostId, result.target)
    } else showMessage(result.reason === 'no-workspace' ? 'No workspace' : 'No repository', result.message)
    return
  }
  if (result.resolvedBy.startsWith('pinned')) await pin(result.repo.path) // new terminals inherit it
  const switched = repo?.path !== result.repo.path
  const shown = new Set(switched ? [] : commits.map((c) => c.hash))
  repo = result.repo
  commits = append ? commits.concat(result.commits) : result.commits
  hasMore = result.hasMore
  if (switched) {
    status = null // the other repo's: no uncommitted-changes row until this one's status arrives
    detailsCache.clear()
    select(null)
    listEl.scrollTop = 0
  }
  hideMessage()
  renderHeader()
  renderList()
  if (!append) {
    animateArrivals(shown)
    void loadStatus()
  }
  // A short page may not fill the list; keep loading until it scrolls.
  queueMicrotask(maybeLoadMore)
}

// ---- Status: branch, upstream, uncommitted changes, a stopped merge --------------------------

let status: RepoStatus | null = null
let statusSeq = 0
const toolbar = createToolbar()
refreshEl.before(toolbar.node)

function setStatus(next: RepoStatus | null): void {
  const before = wipLabel()
  status = next
  toolbar.render(status)
  renderBanner(bannerEl, status)
  if (wipLabel() !== before) renderList()
  if (selected === WORKTREE && rowOf(WORKTREE)) void loadDetails(WORKTREE)
}

// ---- Uncommitted changes: a row above the commits, linked to HEAD ----------------------------

/** The uncommitted-changes row's id; never a hex hash, so no git command ever gets it. */
const WORKTREE = 'worktree'

/** Files with uncommitted changes (staged, unstaged, untracked, conflicted); 0 when clean. */
function wipCount(): number {
  if (!status?.head) return 0
  return status.staged + status.unstaged + status.untracked + status.conflicts
}

/** The row's subject, empty without a row; a change means the list has to be redrawn. */
function wipLabel(): string {
  const count = wipCount()
  return count > 0 && commits.length > 0 ? `Uncommitted changes (${count})` : ''
}

function wipCommit(): Commit | null {
  const label = wipLabel()
  if (!label || !status?.head) return null
  return { hash: WORKTREE, shortHash: '*', parents: [status.head], author: '', authoredAt: 0, subject: label, refs: [] }
}

/** Reads status for the shown repo; the newest answer wins. */
async function loadStatus(): Promise<RepoStatus | null> {
  const mine = ++statusSeq
  const path = repo?.path
  if (!path) {
    setStatus(null)
    return null
  }
  try {
    const result: StatusLoad = await orca.plugin.request('repo.status', { path })
    if (mine !== statusSeq || repo?.path !== path) return status
    setStatus(result.ok ? result.status : null)
  } catch {
    if (mine === statusSeq) setStatus(null)
  }
  return status
}

initActions({
  repoPath: () => repo?.path ?? null,
  status: () => status,
  loadStatus,
  refresh
})

/**
 * A fresh list (first load, another repo) slides in row by row from the top; on a refresh,
 * only commits that were not shown before light up briefly.
 */
function animateArrivals(shown: Set<string>): void {
  if (!moving()) return
  const nodes = [...rowsEl.querySelectorAll<HTMLElement>('.row')]
  if (shown.size === 0) {
    nodes.slice(0, 40).forEach((row, i) => {
      row.style.animationDelay = `${i * 12}ms`
      row.classList.add('enter')
    })
    return
  }
  for (const row of nodes) {
    const hash = row.dataset.hash ?? ''
    if (hash !== WORKTREE && !shown.has(hash)) row.classList.add('fresh')
  }
}

function setLoading(on: boolean): void {
  loading = on
  refreshEl.disabled = on
  document.body.classList.toggle('loading', on)
}

// ---- Messages ------------------------------------------------------------------------------

function hideMessage(): void {
  messageEl.hidden = true
  messageEl.replaceChildren()
}

function showMessage(title: string, text: string, tone: 'neutral' | 'warning' | 'danger' = 'neutral'): void {
  renderHeader()
  messageEl.className = `message ${tone}`
  messageEl.replaceChildren(el('div', 'title', title), el('p', '', text))
  messageEl.hidden = false
}

function showError(error: unknown): void {
  const e = error as { code?: string; message?: string }
  showMessage('The worker did not answer', `${e.code ?? 'error'}: ${e.message ?? String(error)}`, 'danger')
}

function showPicker(text: string, candidates: Candidate[]): void {
  showMessage('Which repository is this workspace?', `${text} Pick it once; orca-git-graph remembers.`, 'warning')
  for (const candidate of candidates) {
    const button = el('button', '', candidate.name)
    button.type = 'button'
    button.append(el('small', '', candidate.host ? `${candidate.path} (SSH)` : candidate.path))
    button.addEventListener('click', async () => {
      sessionPick = candidate.path
      await pin(candidate.path)
      void refresh()
    })
    messageEl.append(button)
  }
}

// ---- Rendering -----------------------------------------------------------------------------

const laneColor = (i: number) => `var(--lane-${i % LANE_COLORS})`

function renderHeader(): void {
  repoEl.textContent = repo?.name ?? 'orca-git-graph'
  repoEl.title = repo?.ssh ? `${repo.path} on ssh ${repo.ssh}` : (repo?.path ?? '')
  sshHostEl.hidden = !repo?.ssh
  sshHostEl.title = repo?.ssh ? `On SSH host ${repo.ssh}: change how orca-git-graph reaches it` : ''
  sshHostEl.setAttribute('aria-label', sshHostEl.title)
  branchEl.hidden = !repo?.branch
  branchEl.textContent = repo?.branch ?? ''
  switchRepoEl.hidden = !(repo && pickedRepo)
}

// ---- Motion --------------------------------------------------------------------------------
// Short, eased and skipped entirely when the system asks for reduced motion.

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Animates a height change; with `keep`, the end height holds until the caller cancels. */
function tweenHeight(node: HTMLElement, from: number, to: number, keep = false, duration = 200): Animation | null {
  for (const running of node.getAnimations()) running.cancel()
  if (!moving() || Math.abs(from - to) < 1) return null
  return node.animate(
    [
      { height: `${from}px`, overflow: 'hidden' },
      { height: `${to}px`, overflow: 'hidden' }
    ],
    { duration, easing: EASE, fill: keep ? 'forwards' : 'none' }
  )
}

/** Restarts a one-shot CSS animation class on an element. */
function replay(node: Element, cls: string): void {
  node.classList.remove(cls)
  void (node as HTMLElement).offsetWidth
  node.classList.add(cls)
}

let layout: Layout = layoutGraph([])
let graphWidth = 0
let nodeEls: SVGCircleElement[] = []
let hotRow = -1

function renderList(): void {
  const wip = wipCommit()
  rows = wip ? [wip, ...commits] : commits
  layout = layoutGraph(rows)
  graphWidth = PAD_X * 2 + Math.max(1, layout.width) * COL_W
  applyColumns()
  if (rows.length === 0) {
    rowsEl.replaceChildren(repo ? el('div', 'empty', 'No commits yet') : '')
  } else {
    rowsEl.replaceChildren(
      ...rows.map((commit, row) =>
        commit === wip ? renderWipRow(commit, graphWidth) : renderRow(commit, graphWidth, layout.colors[row])
      )
    )
  }
  placeDetails()
  updateFindMatches(true)
}

/**
 * Draws lanes and nodes. Rows below the expanded commit move down by the details' height, and
 * the lanes run straight through it.
 */
function drawGraph(): void {
  // Follow where the details actually are, not the selection: they stay put while closing.
  const anchor = detailsEl.hidden ? undefined : (detailsEl.previousElementSibling as HTMLElement | null)?.dataset.hash
  const open = anchor ? rows.findIndex((c) => c.hash === anchor) : -1
  const extra = open >= 0 ? detailsEl.offsetHeight : 0
  const x = (col: number) => PAD_X + col * COL_W + COL_W / 2
  const headerHeight = commitHeaderEl.offsetHeight
  const y = (row: number) => headerHeight + row * ROW_H + ROW_H / 2 + (open >= 0 && row > open ? extra : 0)

  graphEl.setAttribute('width', String(graphWidth))
  graphEl.setAttribute('height', String(headerHeight + rows.length * ROW_H + extra + (hasMore ? ROW_H : 0)))
  const wip = rows[0]?.hash === WORKTREE
  const paths = layout.edges.map((edge) => {
    const path = svg('path', { d: edgePath(edge, x, y, ROW_H), stroke: laneColor(edge.color) })
    if (wip && edge.fromRow === 0) path.classList.add('wip')
    return path
  })
  nodeEls = rows.map((commit, row) => {
    const isHead = commit.refs.some((r) => r.kind === 'head' || r.kind === 'detached')
    const node = svg('circle', {
      cx: x(layout.cols[row]),
      cy: y(row),
      r: isHead ? NODE_R + 1 : NODE_R,
      fill: laneColor(layout.colors[row]),
      stroke: laneColor(layout.colors[row])
    })
    node.classList.toggle('head', isHead)
    node.classList.toggle('wip', commit.hash === WORKTREE)
    node.classList.toggle('hot', row === hotRow)
    node.classList.toggle('picked', commit.hash === selected)
    return node
  })
  graphEl.replaceChildren(...paths, ...nodeEls)
}

/** Grows the node of the row under the pointer. */
function setHotRow(row: number): void {
  if (row === hotRow) return
  nodeEls[hotRow]?.classList.remove('hot')
  hotRow = row
  nodeEls[hotRow]?.classList.add('hot')
}

function renderRow(commit: Commit, indent: number, color: number): HTMLElement {
  const isHead = commit.refs.some((r) => r.kind === 'head' || r.kind === 'detached')
  const row = el('div', isHead ? 'row head' : 'row')
  row.dataset.hash = commit.hash
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', String(commit.hash === selected))
  row.title = `${commit.shortHash} · ${commit.author} · ${new Date(commit.authoredAt).toLocaleString()}\n${commit.subject}`
  const description = el('div', 'description')
  description.append(...renderRefs(commit.refs, color), el('span', 'subject', commit.subject))
  row.append(
    el('span', 'graph-space'), description,
    el('span', 'date', formatCommitDate(commit.authoredAt)),
    el('span', 'author', commit.author),
    el('span', 'hash', commit.shortHash)
  )
  return row
}

/** The uncommitted-changes row: no author, date or hash, just what changed. */
function renderWipRow(commit: Commit, indent: number): HTMLElement {
  const row = el('div', 'row wip')
  row.dataset.hash = commit.hash
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', String(commit.hash === selected))
  const parts: string[] = []
  if (status?.staged) parts.push(`${status.staged} staged`)
  if (status?.unstaged) parts.push(`${status.unstaged} unstaged`)
  if (status?.untracked) parts.push(`${status.untracked} untracked`)
  if (status?.conflicts) parts.push(`${status.conflicts} conflicted`)
  row.title = `${commit.subject}\n${parts.join(', ')}`
  row.append(el('span', 'graph-space'), el('span', 'subject', commit.subject), el('span', 'date'), el('span', 'author', parts.join(' · ')), el('span', 'hash'))
  return row
}

/** What a badge stands for, so right-clicking it opens that ref's menu. */
const badgeRefs = new WeakMap<Element, { ref: Ref; remotes: string[] }>()

/** Local branches absorb their same-named remote copies on the same commit: `main · origin`. */
function renderRefs(refs: Ref[], color: number): HTMLElement[] {
  const remotes = refs.filter((r) => r.kind === 'remote')
  const absorbed = new Set<Ref>()
  const badges: HTMLElement[] = []
  const badge = (ref: Ref, cls: string, label: string, remoteNames: string[] = []) => {
    const node = el('span', `ref ${cls}`)
    badgeRefs.set(node, { ref, remotes: remoteNames })
    node.style.color = laneColor(color)
    node.title = [ref.name, ...remoteNames.map((r) => `${r}/${ref.name}`)].join(', ')
    if (ref.kind === 'head') node.append(icon(ICONS.head, 'ref-icon current-ref-icon'))
    else if (ref.kind === 'branch' || ref.kind === 'remote') node.append(icon(ICONS.branch, 'ref-icon'))
    node.append(el('span', 'name', label))
    for (const remote of remoteNames) node.append(el('span', 'remote', remote))
    badges.push(node)
  }
  for (const ref of refs) {
    if (ref.kind === 'head' || ref.kind === 'branch') {
      const twins = remotes.filter((r) => r.name.endsWith(`/${ref.name}`))
      twins.forEach((t) => absorbed.add(t))
      badge(ref, ref.kind, ref.name, twins.map((t) => t.name.slice(0, -ref.name.length - 1)))
    } else if (ref.kind === 'detached') {
      badge(ref, 'head', 'HEAD')
    }
  }
  for (const ref of remotes) if (!absorbed.has(ref)) badge(ref, 'remote-only', ref.name)
  for (const ref of refs) if (ref.kind === 'tag') badge(ref, 'tag', ref.name)
  return badges
}

// ---- Interaction ---------------------------------------------------------------------------

const rowOf = (hash: string) => rowsEl.querySelector<HTMLElement>(`.row[data-hash="${hash}"]`)

/** Selects a commit (null closes the details); its details open in a row under it. */
function select(hash: string | null): void {
  const changed = hash !== selected
  selected = hash
  for (const row of rowsEl.querySelectorAll<HTMLElement>('.row')) {
    row.setAttribute('aria-selected', String(row.dataset.hash === hash))
  }
  nodeEls.forEach((node, i) => node.classList.toggle('picked', rows[i]?.hash === hash))
  if (!changed) return
  placeDetails()
  void loadDetails(selected)
}

/**
 * Selects a commit and scrolls its row into view when it is loaded. `jump` (a parent link)
 * scrolls smoothly and flashes the row so the eye lands on it.
 */
function reveal(hash: string, jump = false): void {
  select(hash)
  const row = rowOf(hash)
  if (!row) return
  row.scrollIntoView({ block: 'nearest', behavior: jump && moving() ? 'smooth' : 'auto' })
  if (jump && moving()) replay(row, 'flash')
}

/** The commit the details pane shows. A refresh re-creates the rows but keeps this content. */
let detailsFor: string | null = null

/** Puts the details right under the selected row, or folds them away; then redraws the lanes. */
function placeDetails(): void {
  const row = selected ? rowOf(selected) : null
  if (selected && !row) selected = null // gone after a refresh (rebased, branch deleted)
  if (row) {
    if (detailsEl.hidden || detailsFor !== selected) {
      detailsFor = selected
      for (const running of detailsEl.getAnimations()) running.cancel()
      detailsEl.replaceChildren()
      detailsEl.style.height = ''
    }
    detailsEl.style.marginLeft = `${graphColumnWidth()}px`
    row.after(detailsEl)
    detailsEl.hidden = false
  } else {
    hideDetails()
    return
  }
  drawGraph()
}

function hideDetails(): void {
  for (const running of detailsEl.getAnimations()) running.cancel()
  detailsFor = null
  detailsEl.style.height = ''
  detailsEl.hidden = true
  detailsEl.replaceChildren()
  drawGraph()
}

/** Renders new details content immediately so opening a commit does not shift the panel in motion. */
function morphDetails(render: () => void): void {
  for (const running of detailsEl.getAnimations()) running.cancel()
  detailsEl.style.height = ''
  render()
  drawGraph()
}

// ---- Commit details ------------------------------------------------------------------------
// A commit's details never change, so they are cached per hash until the repo switches.

const detailsCache = new Map<string, CommitDetails>()
let detailsSeq = 0

async function loadDetails(hash: string | null): Promise<void> {
  const mine = ++detailsSeq
  if (!hash || !repo) return
  if (hash === WORKTREE) return loadWorktree(mine, repo.path)
  const cached = detailsCache.get(hash)
  if (cached) {
    renderDetails(cached)
    return
  }
  // Most answers come back within a few frames: only say "Loading…" when one does not.
  const slow = setTimeout(() => {
    if (mine === detailsSeq) renderDetailsMessage('pending', 'Loading…')
  }, 150)
  try {
    const result: DetailsLoad = await orca.plugin.request('commit.details', { path: repo.path, hash })
    clearTimeout(slow)
    if (mine !== detailsSeq) return
    if (!result.ok) {
      renderDetailsMessage('error', result.message)
      return
    }
    detailsCache.set(hash, result.details)
    renderDetails(result.details)
  } catch (error) {
    clearTimeout(slow)
    if (mine !== detailsSeq) return
    const e = error as { code?: string; message?: string }
    renderDetailsMessage('error', `${e.code ?? 'error'}: ${e.message ?? String(error)}`)
  }
}

/** Uncommitted changes move with every save: never cached, re-read on each status change. */
async function loadWorktree(mine: number, path: string): Promise<void> {
  const slow = setTimeout(() => {
    if (mine === detailsSeq && detailsEl.childElementCount === 0) renderDetailsMessage('pending', 'Loading…')
  }, 150)
  try {
    const result: WorktreeLoad = await orca.plugin.request('worktree.changes', { path })
    clearTimeout(slow)
    if (mine !== detailsSeq || selected !== WORKTREE) return
    if (result.ok) renderWorktree(result.changes)
    else renderDetailsMessage('error', result.message)
  } catch (error) {
    clearTimeout(slow)
    if (mine !== detailsSeq) return
    const e = error as { code?: string; message?: string }
    renderDetailsMessage('error', `${e.code ?? 'error'}: ${e.message ?? String(error)}`)
  }
}

function renderWorktree(changes: WorktreeChanges): void {
  const info = el('div', 'details-info')
  const meta = el('dl', 'details-meta')
  const field = (label: string, value: Node) => {
    const dd = el('dd', '')
    dd.append(value)
    meta.append(el('dt', '', `${label}:`), dd)
  }
  field('Compared to', parentLink(changes.head))
  if (status) {
    field('Staged', el('span', '', String(status.staged)))
    field('Unstaged', el('span', '', String(status.unstaged)))
    field('Untracked', el('span', '', String(status.untracked)))
    if (status.conflicts > 0) field('Conflicts', el('span', '', String(status.conflicts)))
  }
  info.append(meta)
  const grid = el('div', 'details-grid')
  grid.append(info, renderFiles(changes.files, changes.filesTruncated))
  morphDetails(() => detailsEl.replaceChildren(detailsControls(false), grid))
}

/** Top-right of the details: the commit's actions (⋯, not for uncommitted changes) and close. */
function detailsControls(withMenu = true, onBack?: () => void): HTMLElement {
  const controls = el('div', 'details-controls')
  if (onBack) {
    const back = el('button', 'icon details-back')
    back.type = 'button'
    back.title = 'Back to commit details'
    back.setAttribute('aria-label', back.title)
    back.append(icon(ICONS.back))
    back.addEventListener('click', onBack)
    controls.append(back)
  }
  const more = el('button', 'icon details-more')
  more.type = 'button'
  more.title = 'Actions (right-click a commit or badge, or Shift+F10)'
  more.setAttribute('aria-label', 'Commit actions')
  more.setAttribute('aria-haspopup', 'menu')
  more.append(icon(ICONS.more))
  more.addEventListener('click', () => openSelectedMenu(more))
  const close = el('button', 'icon details-close')
  close.type = 'button'
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close commit details')
  close.append(icon(ICONS.close))
  close.addEventListener('click', () => {
    select(null)
    listEl.focus()
  })
  controls.append(...(withMenu ? [more, close] : [close]))
  return controls
}

function renderDetailsMessage(tone: 'pending' | 'error', text: string): void {
  morphDetails(() => detailsEl.replaceChildren(detailsControls(), el('p', tone, text)))
}

/** Two columns when there is room (commit info | changed files), stacked in the sidebar. */
function renderDetails(d: CommitDetails): void {
  const info = el('div', 'details-info')
  const meta = el('dl', 'details-meta')
  const field = (label: string, ...value: Node[]) => {
    const dd = el('dd', '')
    dd.append(...value)
    meta.append(el('dt', '', `${label}:`), dd)
  }
  field('Commit', el('span', 'mono', d.hash))
  if (d.parents.length > 0) field(d.parents.length > 1 ? 'Parents' : 'Parent', ...d.parents.map(parentLink))
  field('Author', ...person(d.author, d.authorEmail))
  field('Author Date', el('span', '', fullDate(d.authoredAt)))
  field('Committer', ...person(d.committer, d.committerEmail))
  field('Committer Date', el('span', '', fullDate(d.committedAt)))
  info.append(meta, el('pre', 'details-message', d.message))

  const grid = el('div', 'details-grid')
  const mergeBase = d.parents.length > 1 && d.comparedTo ? d.comparedTo : undefined
  grid.append(info, renderFiles(d.files, d.filesTruncated, mergeBase, (file) => void openFileDiff(d.hash, file)))
  morphDetails(() => detailsEl.replaceChildren(detailsControls(), grid))
}

async function openFileDiff(hash: string, file: FileChange): Promise<void> {
  if (!repo) return
  const mine = ++detailsSeq
  renderDetailsMessage('pending', 'Loading diff…')
  try {
    const result: FileDiffLoad = await orca.plugin.request('commit.fileDiff', { path: repo.path, hash, filePath: file.path })
    if (mine !== detailsSeq || selected !== hash) return
    if (!result.ok) return renderDetailsMessage('error', result.message)
    renderFileDiff(hash, file, result.diff)
  } catch (error) {
    if (mine === detailsSeq) renderDetailsMessage('error', (error as Error).message)
  }
}

function renderFileDiff(hash: string, file: FileChange, diff: FileDiff): void {
  const viewer = el('div', 'details-diff')
  viewer.append(el('div', 'diff-title mono', file.path))
  if (diff.kind === 'binary') {
    viewer.append(el('p', 'pending', 'Binary file: no text diff is available.'))
  } else {
    const patch = el('pre', 'diff-patch')
    for (const line of diff.patch.split('\n')) {
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'deleted' : ''
      patch.append(el('span', cls, line), '\n')
    }
    viewer.append(patch)
    if (diff.truncated) viewer.append(el('p', 'pending', 'Diff was truncated to keep the panel responsive.'))
  }
  const back = () => {
    const details = detailsCache.get(hash)
    if (details) renderDetails(details)
    else void loadDetails(hash)
  }
  morphDetails(() => detailsEl.replaceChildren(detailsControls(false, back), viewer))
}

function person(name: string, email: string): Node[] {
  return email ? [el('span', '', name), el('span', 'email', ` <${email}>`)] : [el('span', '', name)]
}

/** e.g. "Wed Nov 04 2026 09:47:31 GMT+0100 (Central European Standard Time)" */
const fullDate = (at: number) => new Date(at).toString()

function parentLink(hash: string): HTMLElement {
  const link = el('button', 'parent mono', hash)
  link.type = 'button'
  link.title = rows.some((c) => c.hash === hash) ? 'Show this commit' : 'Not loaded yet: scroll down to load it'
  link.addEventListener('click', () => reveal(hash, true))
  return link
}

// ---- Changed files as a folder tree ----------------------------------------------------------

interface Folder {
  name: string
  folders: Map<string, Folder>
  files: FileChange[]
}

function buildTree(files: FileChange[]): Folder {
  const root: Folder = { name: '', folders: new Map(), files: [] }
  for (const file of files) {
    let folder = root
    for (const part of file.path.split('/').slice(0, -1)) {
      let next = folder.folders.get(part)
      if (!next) {
        next = { name: part, folders: new Map(), files: [] }
        folder.folders.set(part, next)
      }
      folder = next
    }
    folder.files.push(file)
  }
  return root
}

/** A folder whose only content is one folder merges into it: `apps / web / src`. */
function compact(folder: Folder): { label: string; folder: Folder } {
  const names = [folder.name]
  while (folder.files.length === 0 && folder.folders.size === 1) {
    folder = folder.folders.values().next().value as Folder
    names.push(folder.name)
  }
  return { label: names.join(' / '), folder }
}

const STATUS_NAMES: Record<FileChange['status'], string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
  X: 'Changed'
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Folders first, then files, each by name; every folder folds on click. */
function renderFolderContents(folder: Folder, onOpenFile?: (file: FileChange) => void): HTMLElement {
  const list = el('ul', 'tree')
  for (const child of [...folder.folders.values()].sort((a, b) => byName(a.name, b.name))) {
    const { label, folder: shown } = compact(child)
    const item = el('li', '')
    const toggle = el('button', 'tree-row folder')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', 'true')
    toggle.append(chevron(), treeIcon('folder'), el('span', 'name', label))
    const contents = renderFolderContents(shown, onOpenFile)
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true'
      toggle.setAttribute('aria-expanded', String(open))
      if (open) {
        contents.hidden = false
        tweenHeight(contents, 0, contents.offsetHeight, false, 160)
      } else {
        const folding = tweenHeight(contents, contents.offsetHeight, 0, true, 140)
        const done = () => {
          for (const running of contents.getAnimations()) running.cancel()
          contents.hidden = toggle.getAttribute('aria-expanded') !== 'true'
        }
        if (folding) folding.onfinish = done
        else done()
      }
    })
    item.append(toggle, contents)
    list.append(item)
  }
  for (const file of [...folder.files].sort((a, b) => byName(baseName(a.path), baseName(b.path)))) {
    list.append(renderFile(file, onOpenFile))
  }
  return list
}

function renderFile(file: FileChange, onOpenFile?: (file: FileChange) => void): HTMLElement {
  const item = el('li', `tree-row file s-${file.status}${file.untracked ? ' untracked' : ''}`)
  const what = file.untracked ? 'Untracked' : STATUS_NAMES[file.status]
  item.title = `${what}: ${file.from ? `${file.from} → ${file.path}` : file.path}`
  item.append(treeIcon('file'), el('span', 'name', baseName(file.path)))
  if (file.from) item.append(el('span', 'from', `← ${file.from}`))
  if (file.added !== null) {
    const stat = el('span', 'stat')
    stat.append('(', el('span', 'plus', `+${file.added}`), ' | ', el('span', 'minus', `-${file.deleted}`), ')')
    item.append(stat)
  } else {
    item.append(el('span', 'stat', 'binary'))
  }
  if (onOpenFile) {
    item.tabIndex = 0
    item.setAttribute('role', 'button')
    item.setAttribute('aria-label', `Open diff for ${file.path}`)
    item.addEventListener('click', () => onOpenFile(file))
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpenFile(file)
      }
    })
  }
  return item
}

function chevron(): SVGSVGElement {
  const node = svg('svg', { viewBox: '0 0 16 16', class: 'chevron', 'aria-hidden': 'true' })
  node.append(svg('path', { d: 'M6 4l4 4-4 4' }))
  return node
}

function treeIcon(kind: 'folder' | 'file'): SVGSVGElement {
  const node = svg('svg', { viewBox: '0 0 16 16', class: `tree-icon ${kind}`, 'aria-hidden': 'true' })
  node.append(svg('path', { d: kind === 'folder' ? 'M1.5 3.5h5l1.5 1.5h6.5v8h-13z' : 'M3.5 1.5h6l3 3v10h-9z' }))
  return node
}

/** `mergeBase` labels a merge's list with the first parent it is compared with. */
function renderFiles(files: FileChange[], truncated: boolean, mergeBase?: string, onOpenFile?: (file: FileChange) => void): HTMLElement {
  const section = el('div', 'details-files')
  const added = files.reduce((sum, f) => sum + (f.added ?? 0), 0)
  const deleted = files.reduce((sum, f) => sum + (f.deleted ?? 0), 0)
  const head = el('div', 'files-head')
  const count = `${files.length}${truncated ? '+' : ''} ${files.length === 1 ? 'file' : 'files'}`
  head.append(el('span', '', count), el('span', 'plus', `+${added}`), el('span', 'minus', `-${deleted}`))
  if (mergeBase) {
    const against = el('span', 'against', `vs ${mergeBase.slice(0, 7)}`)
    against.title = 'A merge is compared with its first parent'
    head.append(against)
  }
  section.append(head)
  if (files.length === 0) {
    section.append(el('p', 'pending', 'No file changes.'))
    return section
  }
  section.append(renderFolderContents(buildTree(files), onOpenFile))
  if (truncated) section.append(el('p', 'pending', `Only the first ${files.length} files are listed.`))
  return section
}

// The details change height as they load, wrap or fold folders: keep the lanes in step.
new ResizeObserver(() => {
  if (!detailsEl.hidden) drawGraph()
}).observe(detailsEl)

function maybeLoadMore(): void {
  if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - ROW_H * 10) void loadMore()
}

function updateFindMatches(keepCurrent = false): void {
  const current = keepCurrent ? findMatches[findIndex] : undefined
  findMatches = findCommitHashes(commits, findInputEl.value)
  findIndex = current ? findMatches.indexOf(current) : findMatches.length > 0 ? 0 : -1
  if (findIndex < 0 && findMatches.length > 0) findIndex = 0
  const matched = new Set(findMatches)
  for (const row of rowsEl.querySelectorAll<HTMLElement>('.row')) {
    row.classList.toggle('find-match', matched.has(row.dataset.hash ?? ''))
    row.classList.toggle('find-current', row.dataset.hash === findMatches[findIndex])
  }
  findCountEl.textContent = findInputEl.value.trim() ? (findIndex >= 0 ? `${findIndex + 1} of ${findMatches.length}` : 'No matches') : ''
}

function moveFind(step: number): void {
  if (findMatches.length === 0) return
  findIndex = (findIndex + step + findMatches.length) % findMatches.length
  updateFindMatches(true)
  rowOf(findMatches[findIndex])?.scrollIntoView({ block: 'center', behavior: moving() ? 'smooth' : 'auto' })
}

function openFind(): void {
  findEl.hidden = false
  findInputEl.focus()
  findInputEl.select()
  updateFindMatches(true)
}

function closeFind(): void {
  findEl.hidden = true
  findInputEl.value = ''
  updateFindMatches()
  listEl.focus()
}

rowsEl.addEventListener('click', (event) => {
  if ((event.target as Element).closest('.ref')) return
  const row = (event.target as Element).closest<HTMLElement>('.row')
  // Clicking the open commit again folds its details.
  if (row?.dataset.hash) select(row.dataset.hash === selected ? null : row.dataset.hash)
})

rowsEl.addEventListener('dblclick', (event) => {
  const badge = (event.target as Element).closest('.ref')
  const info = badge ? badgeRefs.get(badge) : undefined
  if (!info || !['head', 'branch', 'remote'].includes(info.ref.kind)) return
  event.preventDefault()
  event.stopPropagation()
  checkoutRef(info.ref)
})

// Right-click: a badge opens its ref's menu, anywhere else on a row the commit's. It leaves the
// selection and the details as they are; the row is only outlined while its menu is open.
rowsEl.addEventListener('contextmenu', (event) => {
  const target = event.target as Element
  const row = target.closest<HTMLElement>('.row')
  const commit = row ? commits.find((c) => c.hash === row.dataset.hash) : undefined
  if (!row || !commit) return
  event.preventDefault()
  const at = { x: event.clientX, y: event.clientY }
  const options = { returnFocus: listEl, onClose: () => row.classList.remove('menu-target') }
  row.classList.add('menu-target')
  const badge = target.closest('.ref')
  const info = badge ? badgeRefs.get(badge) : undefined
  if (info) refMenu(info.ref, info.remotes, commit, at, options)
  else commitMenu(commit, at, options)
})

/** The selected commit's menu, opened from the keyboard or the details' ⋯ button. */
function openSelectedMenu(anchor?: Element): void {
  const commit = commits.find((c) => c.hash === selected)
  const row = selected ? rowOf(selected) : null
  if (!commit || !row) return
  const box = (anchor ?? row).getBoundingClientRect()
  commitMenu(commit, { x: anchor ? box.right - 4 : box.left + graphWidth, y: box.bottom }, { returnFocus: listEl })
}

listEl.addEventListener('keydown', (event) => {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault()
    openSelectedMenu()
  }
})

rowsEl.addEventListener('mouseover', (event) => {
  const row = (event.target as Element).closest<HTMLElement>('.row')
  setHotRow(row ? rows.findIndex((c) => c.hash === row.dataset.hash) : -1)
})
rowsEl.addEventListener('mouseleave', () => setHotRow(-1))

listEl.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = rows.findIndex((c) => c.hash === selected)
  const next = Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
  if (!rows[next]) return
  reveal(rows[next].hash)
})

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    openFind()
    return
  }
  if (event.key === 'Escape' && !findEl.hidden) {
    event.preventDefault()
    closeFind()
    return
  }
  // A menu or dialog that handled Escape already marked it.
  if (event.key === 'Escape' && selected && !event.defaultPrevented) {
    select(null)
    listEl.focus()
  }
})

listEl.addEventListener('scroll', maybeLoadMore, { passive: true })
refreshEl.addEventListener('click', () => void refresh())
switchRepoEl.append(icon(ICONS.switch))
switchRepoEl.addEventListener('click', () => void unpin())
sshHostEl.append(icon(ICONS.server))
sshHostEl.addEventListener('click', () => {
  if (repo?.ssh && repo.hostId) void askSshTarget(repo.hostId, repo.ssh)
})
for (const handle of commitHeaderEl.querySelectorAll<HTMLElement>('.column-resize')) {
  handle.addEventListener('pointerdown', (event) => {
    const cell = handle.parentElement as HTMLElement
    const column = cell.dataset.column as ColumnName
    const startX = event.clientX
    const startWidth = cell.getBoundingClientRect().width
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => saveColumn(column, startWidth + next.clientX - startX)
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up) }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
}
searchEl.append(icon(ICONS.search))
searchEl.addEventListener('click', openFind)
findPreviousEl.append(icon(ICONS.up))
findPreviousEl.addEventListener('click', () => moveFind(-1))
findNextEl.append(icon(ICONS.down))
findNextEl.addEventListener('click', () => moveFind(1))
findCloseEl.append(icon(ICONS.close))
findCloseEl.addEventListener('click', closeFind)
findInputEl.addEventListener('input', () => {
  updateFindMatches()
  if (findMatches.length > 0) moveFind(0)
})
findInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    moveFind(event.shiftKey ? -1 : 1)
  }
})

orca.plugin.on('repo.changed', () => void refresh())
// A file was saved or deleted: only the uncommitted-changes row (and its open details) moves.
orca.plugin.on('worktree.changed', (payload: { path: string }) => {
  if (payload.path === repo?.path) void loadStatus()
})
// Fires when focus moves to another workspace (its first delivery on subscribe is not relied on).
orca.on('workspace.changed', () => {
  sessionPick = null
  void refresh()
})
void refresh()
