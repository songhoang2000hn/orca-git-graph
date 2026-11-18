// Finline's worker: finds the focused workspace's repository, reads it with the system `git`,
// runs the git actions the panel asks for, and watches the git dir so open panels refresh.
// A workspace on an SSH host runs the same git commands through the system `ssh`, and is
// polled instead of watched.
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { AUTH_FAILURE, buildArgs, CONFLICT, isRemoteAction } from './actions'
import {
  currentBranch,
  git,
  gitDirs,
  gitVersion,
  isSshTarget,
  type Loc,
  markersIn,
  readCommitDetails,
  readCommits,
  readStatus,
  readWorktreeChanges,
  remoteNames,
  runGit,
  SshError
} from './git'
import type { ActionResult, Candidate, DetailsLoad, GraphLoad, StatusLoad, WorktreeLoad } from './types'

const DEFAULT_LIMIT = 200
// About 250 bytes of JSON per commit keeps a full page well under the 1 MiB answer cap.
const MAX_LIMIT = 1000
const DEBOUNCE_MS = 300
// Edits in the working tree come in bursts (a save, a build, an install): wait for a pause,
// but never longer than this, so a busy tree still refreshes.
const WORKTREE_DEBOUNCE_MS = 500
const WORKTREE_MAX_WAIT_MS = 3000
// About 100 bytes of JSON per file; a huge commit lists the first ones and says it was cut.
const MAX_FILES = 2000
const HASH = /^[0-9a-f]{4,64}$/i
// Paths under the git dir whose change means the graph may have changed.
// Stopped merges, rebases and cherry-picks leave marker files there too.
const RELEVANT =
  /^(packed-refs|refs[\\/].*|(worktrees[\\/][^\\/]+[\\/])?(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|rebase-merge|rebase-apply))$/
// Remote actions wait on the network; local ones should be quick but a big rebase is not.
const REMOTE_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 60_000
// An SSH host has no file watcher to lean on: ask it for a fingerprint this often, and less
// often while it fails. Polling stops when no panel has asked anything for a while.
const POLL_MS = 4000
const POLL_FAILING_MS = 30_000
const POLL_IDLE_MS = 10 * 60_000

type Resolved =
  | { ok: true; loc: Loc; hostId: string | null; resolvedBy: string }
  | Exclude<GraphLoad, { ok: true } | { reason: 'git-failed' }>

interface WorkspaceRow {
  id: string
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

const isLocal = (hostId: string | null) => hostId === null || hostId === 'local'
const isSsh = (hostId: string | null) => Boolean(hostId?.startsWith('ssh:'))
// Windows paths compare without case or slash direction; remote (POSIX) paths compare exactly.
const samePath = (a: string, b: string, hostId: string | null = 'local') =>
  isLocal(hostId)
    ? a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
    : a === b

/**
 * Development aid: a repo path in `<plugin>/.orca/dev-repo.txt` overrides the focused workspace,
 * so the graph can be tried on a fixture repo. `.orca/` is git-ignored and never shipped.
 */
async function devOverride(): Promise<string | null> {
  try {
    const file = fileURLToPath(new URL('../.orca/dev-repo.txt', import.meta.url))
    const path = (await readFile(file, 'utf8')).trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * Turns a workspace row into where git runs. An SSH workspace needs the ssh destination the
 * panel saved for its host: Orca names the host only by an id (`ssh:<connection>`).
 */
function locate(
  w: WorkspaceRow,
  sshTargets: Record<string, string>,
  resolvedBy: string
): Resolved {
  if (isLocal(w.hostId)) return { ok: true, loc: { path: w.path, ssh: null }, hostId: w.hostId, resolvedBy }
  if (!isSsh(w.hostId)) {
    return { ok: false, reason: 'remote', message: `"${w.name}" runs on ${w.hostId}, which Finline cannot reach yet.` }
  }
  const hostId = w.hostId as string
  const target = sshTargets[hostId]
  if (!target || !isSshTarget(target)) {
    return {
      ok: false,
      reason: 'ssh-target',
      hostId,
      message: `"${w.name}" is on an SSH host. Tell Finline how to reach it with ssh, as you would in a terminal.`
    }
  }
  return { ok: true, loc: { path: w.path, ssh: target }, hostId, resolvedBy: `${resolvedBy} via ssh ${target}` }
}

async function resolveRepo(
  orca: OrcaWorkerApi,
  preferredPath: string | undefined,
  sshTargets: Record<string, string>
): Promise<Resolved> {
  const override = await devOverride()
  if (override) {
    // `ssh:<target>:<path>` tries the remote path on a fixture host.
    const remote = /^ssh:([^:]+):(.+)$/.exec(override)
    return remote
      ? { ok: true, loc: { path: remote[2], ssh: remote[1] }, hostId: 'ssh:dev', resolvedBy: 'dev override (.orca/dev-repo.txt)' }
      : { ok: true, loc: { path: override, ssh: null }, hostId: 'local', resolvedBy: 'dev override (.orca/dev-repo.txt)' }
  }

  const context = await orca.host.call('workspace.readContext', {})
  if (!context) return { ok: false, reason: 'no-workspace', message: 'No workspace is focused.' }
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: WorkspaceRow[] }

  // Newer Orca names the focused workspace's id; then there is nothing to guess.
  const id = (context as { workspaceId?: string }).workspaceId
  const exact = id ? workspaces.find((w) => w.id === id) : undefined
  if (exact) return locate(exact, sshTargets, 'workspace id')

  // Older Orca: match readContext against workspace.list by name and branch.
  const matches = workspaces.filter(
    (w) => w.name === context.displayName && (w.branch ?? null) === (context.branch || null)
  )
  if (matches.length === 0) {
    return { ok: false, reason: 'not-found', message: `No workspace "${context.displayName}" on ${context.branch}.` }
  }
  if (matches.length === 1) return locate(matches[0], sshTargets, 'name+branch')

  const pinned = preferredPath ? matches.find((w) => samePath(w.path, preferredPath, w.hostId)) : undefined
  if (pinned) return locate(pinned, sshTargets, `pinned (1 of ${matches.length})`)

  const candidates: Candidate[] = matches.map((w) => ({
    path: w.path,
    name: basename(w.path),
    branch: w.branch,
    ...(isLocal(w.hostId) ? {} : { host: w.hostId as string })
  }))
  return {
    ok: false,
    reason: 'ambiguous',
    message: `${matches.length} workspaces are named "${context.displayName}" on ${context.branch}.`,
    candidates
  }
}

let watcher: FSWatcher | null = null
let worktreeWatcher: FSWatcher | null = null
// The main worktree holds the git dir; its changes are the other watcher's business.
const IN_GIT_DIR = /^\.git([\\/]|$)/

export default function activate(orca: OrcaWorkerApi): void {
  let watchedPath: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Repos graph.load has resolved, by the path the panel sends back: other handlers run git
  // only in one of these, on the host it was found on.
  const served = new Map<string, Loc>()

  async function watchRepo(loc: Loc): Promise<boolean> {
    const path = loc.path
    if (loc.ssh) return pollRepo(loc)
    stopPolling()
    if (watchedPath === path && watcher) return true
    watcher?.close()
    watcher = null
    worktreeWatcher?.close()
    worktreeWatcher = null
    watchedPath = path
    try {
      const { commonDir } = await gitDirs(path)
      // The common dir holds refs and, under worktrees/<name>, each worktree's HEAD and index.
      watcher = watch(commonDir, { recursive: true }, (_event, file) => {
        if (file && (!RELEVANT.test(String(file)) || String(file).endsWith('.lock'))) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          orca.log(`repo changed (${String(file)}), notifying panels`)
          orca.panels.post('repo.changed', { path })
        }, DEBOUNCE_MS)
      })
      watcher.on('error', (error) => orca.log(`watch error: ${error.message}`))
      orca.log(`watching ${commonDir}`)
      watchWorktree(path)
      return true
    } catch (error) {
      watchedPath = null
      orca.log(`watch failed: ${(error as Error).message}`)
      return false
    }
  }

  // ---- SSH hosts: no fs.watch there, so compare fingerprints -------------------------------

  let polled: { loc: Loc; refs: string | null; tree: string | null; timer: ReturnType<typeof setTimeout> | null } | null = null
  let lastAsked = Date.now()
  const touch = () => {
    lastAsked = Date.now()
    if (polled && !polled.timer) schedulePoll(POLL_MS)
  }

  function stopPolling(): void {
    if (polled?.timer) clearTimeout(polled.timer)
    polled = null
  }

  /** What the graph and the uncommitted-changes row depend on, read in three short git calls. */
  async function fingerprint(loc: Loc): Promise<{ refs: string; tree: string }> {
    const [refs, head, tree, { gitDir }] = await Promise.all([
      git(loc, ['for-each-ref', '--format=%(objectname) %(refname)']),
      git(loc, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => ''),
      git(loc, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']),
      gitDirs(loc)
    ])
    const markers = await markersIn(loc, gitDir)
    return { refs: `${head}\n${refs}\n${markers.join(',')}`, tree }
  }

  function schedulePoll(wait: number): void {
    if (!polled) return
    if (polled.timer) clearTimeout(polled.timer)
    polled.timer = setTimeout(() => void poll(), wait)
  }

  async function poll(): Promise<void> {
    const current = polled
    if (!current) return
    current.timer = null
    // Nobody looked for a while (panel closed or hidden): stop until the next request.
    if (Date.now() - lastAsked > POLL_IDLE_MS) return
    try {
      const next = await fingerprint(current.loc)
      if (polled !== current) return
      if (current.refs !== null && next.refs !== current.refs) {
        orca.log(`repo changed on ${current.loc.ssh}, notifying panels`)
        orca.panels.post('repo.changed', { path: current.loc.path })
      } else if (current.tree !== null && next.tree !== current.tree) {
        orca.panels.post('worktree.changed', { path: current.loc.path })
      }
      current.refs = next.refs
      current.tree = next.tree
      schedulePoll(POLL_MS)
    } catch (error) {
      if (polled !== current) return
      orca.log(`poll failed on ${current.loc.ssh}: ${(error as Error).message}`)
      schedulePoll(POLL_FAILING_MS)
    }
  }

  function pollRepo(loc: Loc): boolean {
    if (polled && polled.loc.path === loc.path && polled.loc.ssh === loc.ssh) {
      if (!polled.timer) schedulePoll(POLL_MS)
      return true
    }
    watcher?.close()
    watcher = null
    worktreeWatcher?.close()
    worktreeWatcher = null
    watchedPath = null
    stopPolling()
    polled = { loc, refs: null, tree: null, timer: null }
    orca.log(`polling ${loc.ssh}:${loc.path} every ${POLL_MS} ms`)
    void poll()
    return true
  }

  let worktreeTimer: ReturnType<typeof setTimeout> | null = null
  let worktreeSince = 0

  /** Posts `worktree.changed` when files change, so the uncommitted-changes row stays current. */
  function watchWorktree(path: string): void {
    worktreeWatcher?.close()
    worktreeWatcher = null
    try {
      worktreeWatcher = watch(path, { recursive: true }, (_event, file) => {
        if (file && IN_GIT_DIR.test(String(file))) return
        const now = Date.now()
        if (!worktreeTimer) worktreeSince = now
        else clearTimeout(worktreeTimer)
        const wait = Math.max(0, Math.min(WORKTREE_DEBOUNCE_MS, worktreeSince + WORKTREE_MAX_WAIT_MS - now))
        worktreeTimer = setTimeout(() => {
          worktreeTimer = null
          orca.panels.post('worktree.changed', { path })
        }, wait)
      })
      worktreeWatcher.on('error', (error) => orca.log(`worktree watch error: ${error.message}`))
    } catch (error) {
      orca.log(`worktree watch failed: ${(error as Error).message}`)
    }
  }

  stopRemote = stopPolling

  orca.panels.handle('graph.load', async ({ limit, skip, preferredPath, sshTargets }, { signal }): Promise<GraphLoad> => {
    touch()
    const resolved = await resolveRepo(orca, preferredPath, sshTargets ?? {})
    if (!resolved.ok) return resolved
    const { loc } = resolved
    const max = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const from = Math.max(0, skip ?? 0)
    try {
      const remotes = await remoteNames(loc)
      const [version, branch, page] = await Promise.all([
        gitVersion(loc),
        currentBranch(loc),
        // One extra tells us whether another page exists.
        readCommits(loc, { skip: from, limit: max + 1, remotes }, signal)
      ])
      const watching = await watchRepo(loc)
      served.set(loc.path, loc)
      const name = loc.ssh ? loc.path.split('/').filter(Boolean).pop() ?? loc.path : basename(loc.path)
      return {
        ok: true,
        repo: { path: loc.path, name, branch, gitVersion: version, ...(loc.ssh ? { ssh: loc.ssh, hostId: resolved.hostId as string } : {}) },
        commits: page.slice(0, max),
        skip: from,
        hasMore: page.length > max,
        resolvedBy: resolved.resolvedBy,
        watching
      }
    } catch (error) {
      if (error instanceof SshError && resolved.hostId) {
        return { ok: false, reason: 'ssh-failed', hostId: resolved.hostId, target: loc.ssh as string, message: error.message }
      }
      return { ok: false, reason: 'git-failed', message: (error as Error).message }
    }
  })

  orca.panels.handle('repo.status', async ({ path }, { signal }): Promise<StatusLoad> => {
    const loc = served.get(path)
    touch()
    if (!loc) return { ok: false, message: 'Unknown repository; reload the graph.' }
    try {
      return { ok: true, status: await readStatus(loc, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  // One action at a time per repository: git takes its own locks, but two at once from the
  // panel would only race each other.
  const running = new Set<string>()

  orca.panels.handle('git.run', async ({ path, action }, { signal }): Promise<ActionResult> => {
    const loc = served.get(path)
    touch()
    if (!loc) return { ok: false, reason: 'invalid', message: 'Unknown repository; reload the graph.' }
    if (running.has(path)) return { ok: false, reason: 'invalid', message: 'Another git action is still running.' }
    running.add(path)
    try {
      const built = buildArgs(action, { remotes: await remoteNames(loc) })
      if (!built.ok) return { ok: false, reason: 'invalid', message: built.message }
      const remote = isRemoteAction(action)
      orca.log(`git ${built.args.join(' ')}`)
      const result = await runGit(loc, built.args, { timeoutMs: remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS, signal })
      const output = [result.stdout, result.stderr].map((s) => s.trim()).filter(Boolean).join('\n')
      if (result.code === 0) return { ok: true, output }
      if (result.timedOut) {
        return { ok: false, reason: 'timeout', message: `git ${built.args[0]} took too long and was stopped.\n${output}` }
      }
      if (remote && AUTH_FAILURE.test(output)) return { ok: false, reason: 'auth', message: output }
      if (CONFLICT.test(output)) return { ok: false, reason: 'conflict', message: output }
      return { ok: false, reason: 'failed', message: output || `git ${built.args[0]} failed (exit ${result.code}).` }
    } catch (error) {
      return { ok: false, reason: 'failed', message: (error as Error).message }
    } finally {
      running.delete(path)
    }
  })

  orca.panels.handle('git.terminal', async ({ path, action }) => {
    const loc = served.get(path)
    touch()
    if (!loc) return { ok: false, message: 'Unknown repository; reload the graph.' }
    if (!isRemoteAction(action)) return { ok: false, message: 'Only fetch, pull and push run in a terminal.' }
    const built = buildArgs(action, { remotes: await remoteNames(loc) })
    if (!built.ok) return { ok: false, message: built.message }
    const { workspaces } = await orca.host.call('workspace.list', {})
    // The workspace's own terminal runs on its host, local or SSH, where git finds the repo.
    const workspace = (workspaces as WorkspaceRow[]).find(
      (w) => samePath(w.path, path, w.hostId) && isLocal(w.hostId) === !loc.ssh
    )
    if (!workspace) return { ok: false, message: 'No Orca workspace has this repository open.' }
    // Every argument passed buildArgs' checks (names from a safe character set), so plain
    // quoting is enough for any shell the terminal runs.
    const quote = (arg: string) => (/^[\w.\/@:+=-]+$/.test(arg) ? arg : `"${arg}"`)
    const command = ['git', ...built.args].map(quote).join(' ')
    await orca.host.call('terminal.create', { workspaceId: workspace.id, title: `Finline: git ${built.args[0]}`, command })
    return { ok: true }
  })

  orca.panels.handle('worktree.changes', async ({ path }, { signal }): Promise<WorktreeLoad> => {
    const loc = served.get(path)
    touch()
    if (!loc) return { ok: false, message: 'Unknown repository; reload the graph.' }
    try {
      return { ok: true, changes: await readWorktreeChanges(loc, MAX_FILES, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  orca.panels.handle('commit.details', async ({ path, hash }, { signal }): Promise<DetailsLoad> => {
    const loc = served.get(path)
    touch()
    if (!loc) return { ok: false, message: 'Unknown repository; reload the graph.' }
    if (!HASH.test(hash)) return { ok: false, message: `Not a commit hash: ${hash}` }
    try {
      return { ok: true, details: await readCommitDetails(loc, hash, MAX_FILES, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })
}

let stopRemote: (() => void) | null = null

export function deactivate(): void {
  stopRemote?.()
  watcher?.close()
  watcher = null
  worktreeWatcher?.close()
  worktreeWatcher = null
}
