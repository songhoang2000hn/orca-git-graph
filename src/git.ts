// Thin wrapper over the system `git`, run with execFile (no shell) so paths with spaces and
// Windows drive letters pass through untouched. A repository on an SSH host runs the same git
// arguments through the system `ssh` (see `Loc`), quoted for the remote shell.
import { execFile } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Commit, CommitDetails, FileChange, FileDiff, FileStatus, Operation, Ref, RepoStatus, WorktreeChanges } from './types'

const FIELD = '\x1f'
const RECORD = '\x1e'
// hash, short hash, parents, author, author time (unix s), decorations, subject
const FORMAT = ['%H', '%h', '%P', '%an', '%at', '%D', '%s'].join('%x1f') + '%x1e'
const BASE_ARGS = ['-c', 'core.quotepath=off', '-c', 'color.ui=false']

/**
 * Where a repository lives: a path on this machine (`ssh: null`), or a path on an SSH host,
 * reached as `ssh <ssh>` (an alias from ~/.ssh/config or `user@host`). A plain string is a
 * local path.
 */
export interface Loc {
  path: string
  ssh: string | null
}

export const toLoc = (loc: string | Loc): Loc => (typeof loc === 'string' ? { path: loc, ssh: null } : loc)

// An ssh destination: an alias or [user@]host[:port] in plain characters, never an option.
const SSH_TARGET = /^(?!-)[A-Za-z0-9._@%+\[\]:-]{1,255}$/
export const isSshTarget = (target: string) => SSH_TARGET.test(target)

/** Quotes one word for a POSIX shell (the remote side of ssh runs the command through one). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * Options for every ssh call: never prompt (a background panel cannot answer), give up on a
 * dead host quickly, and share one connection between the many short git calls a refresh makes.
 * Windows' OpenSSH has no connection sharing.
 */
export function sshArgs(target: string, command: string[]): string[] {
  const share =
    process.platform === 'win32'
      ? []
      : ['-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/orca-git-graph-%C', '-o', 'ControlPersist=300']
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    ...share,
    '--', target,
    command.map(shellQuote).join(' ')
  ]
}

interface ExecOptions {
  maxBuffer: number
  timeout?: number
  signal?: AbortSignal
  env?: Record<string, string>
}

/**
 * Runs `argv` (a program and its arguments) at `loc`: here with execFile, or on the SSH host
 * through `ssh`, where extra environment goes in front as `env NAME=value`.
 */
function exec(
  loc: Loc,
  argv: string[],
  opts: ExecOptions,
  done: (error: (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void
) {
  const { env, ...rest } = opts
  const options = { encoding: 'utf8' as const, windowsHide: true, ...rest }
  if (!loc.ssh) {
    return execFile(argv[0], argv.slice(1), { ...options, env: env ? { ...process.env, ...env } : undefined }, done)
  }
  if (!isSshTarget(loc.ssh)) throw new Error(`Not an SSH host: ${loc.ssh}`)
  const remote = env ? ['env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv] : argv
  return execFile('ssh', sshArgs(loc.ssh, remote), options, done)
}

/** ssh exits with 255 when it could not reach or log in to the host (git itself never does). */
const sshFailed = (loc: Loc, code: unknown) => Boolean(loc.ssh) && code === 255

function sshMessage(loc: Loc, stderr: string): string {
  return `ssh ${loc.ssh} failed: ${stderr.trim() || 'no answer'}`
}

export function git(at: string | Loc, args: string[], signal?: AbortSignal): Promise<string> {
  const loc = toLoc(at)
  return new Promise((resolve, reject) => {
    exec(loc, ['git', '-C', loc.path, ...BASE_ARGS, ...args], { maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (!error) resolve(stdout)
      else if (sshFailed(loc, error.code)) reject(new SshError(sshMessage(loc, stderr)))
      else reject(new Error((stderr || error.message).trim()))
    })
  })
}

/** The SSH host could not be reached or refused the login, as opposed to git failing there. */
export class SshError extends Error {}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Runs git for an action: never throws for a non-zero exit, keeps stderr (where push, pull and
 * merge report), and stops after `timeoutMs`. Prompts are off, so nothing waits on a person.
 */
export function runGit(
  at: string | Loc,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<RunResult> {
  const loc = toLoc(at)
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0', // fail instead of asking for a username or password
    GIT_EDITOR: 'true', // accept prepared messages (merge, revert, rebase --continue)
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GCM_INTERACTIVE: 'auto' // Git Credential Manager may still show its own sign-in window
  }
  return new Promise((resolve) => {
    const child = exec(
      loc,
      ['git', '-C', loc.path, ...BASE_ARGS, ...args],
      { maxBuffer: 8 * 1024 * 1024, timeout: opts.timeoutMs, signal: opts.signal, env },
      (error, stdout, stderr) => {
        const failure = error
        resolve({
          code: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0,
          stdout,
          stderr: sshFailed(loc, failure?.code)
            ? sshMessage(loc, stderr)
            : stderr || (failure && typeof failure.code !== 'number' ? failure.message : ''),
          timedOut: Boolean(failure?.killed)
        })
      }
    )
    child.stdin?.end() // nothing to read: a prompt that slips through sees end of input
  })
}

/** One worktree as the Orca CLI on a host lists it (`orca worktree list --json`). */
export interface HostWorktree {
  displayName: string
  branch: string | null
  path: string
}

/**
 * Asks the Orca CLI on an SSH host which worktrees it has: Orca installs it at
 * `~/.orca/cli/bin/orca` on every host it manages. Used when Orca does not list a remote
 * workspace to plugins, so its folder is unknown on this side.
 */
export function hostWorktrees(target: string): Promise<HostWorktree[]> {
  const loc: Loc = { path: '.', ssh: target }
  const script = 'o="$HOME/.orca/cli/bin/orca"; [ -x "$o" ] || o=orca; exec "$o" worktree list --json'
  return new Promise((resolve, reject) => {
    exec(loc, ['sh', '-c', script], { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(sshFailed(loc, error.code) ? new SshError(sshMessage(loc, stderr)) : new Error((stderr || error.message).trim()))
        return
      }
      try {
        resolve(parseHostWorktrees(stdout))
      } catch (parseError) {
        reject(new Error(`The Orca CLI on ${target} answered something else: ${(parseError as Error).message}`))
      }
    })
  })
}

export function parseHostWorktrees(out: string): HostWorktree[] {
  const answer = JSON.parse(out) as { result?: { worktrees?: unknown[] } }
  const rows = answer.result?.worktrees
  if (!Array.isArray(rows)) throw new Error('no worktree list')
  return rows.flatMap((row): HostWorktree[] => {
    const w = row as { displayName?: unknown; branch?: unknown; path?: unknown }
    if (typeof w.path !== 'string' || typeof w.displayName !== 'string') return []
    const branch = typeof w.branch === 'string' ? w.branch.replace(/^refs\/heads\//, '') || null : null
    return [{ displayName: w.displayName, branch, path: w.path }]
  })
}

/**
 * Narrows the host's worktree list to the focused workspace. Some remote Orca contexts omit
 * their branch, so use it as a discriminator only when the host supplied one.
 */
export function selectHostWorktrees(worktrees: HostWorktree[], displayName: string, branch: string | null): HostWorktree[] {
  return worktrees.filter((worktree) => worktree.displayName === displayName && (branch === null || worktree.branch === branch))
}

/** Names in a directory on the SSH host (`ls -A`), or an empty list when it can't be read. */
function remoteEntries(loc: Loc, dir: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    exec(loc, ['ls', '-1A', '--', dir], { maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(new Set(error ? [] : stdout.split(/\r?\n/).filter(Boolean)))
    )
  })
}

/**
 * Parses `git status --porcelain=v2 --branch -z`: branch headers, then one record per path
 * (`1` changed, `2` renamed with an extra path token, `u` unmerged, `?` untracked).
 */
export function parseStatus(
  out: string
): Pick<RepoStatus, 'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'staged' | 'unstaged' | 'untracked' | 'conflicts'> {
  const status = { branch: null as string | null, head: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('# branch.oid ')) {
      const oid = token.slice(13)
      status.head = oid === '(initial)' ? null : oid
    } else if (token.startsWith('# branch.head ')) {
      const head = token.slice(14)
      status.branch = head === '(detached)' ? null : head
    } else if (token.startsWith('# branch.upstream ')) {
      status.upstream = token.slice(18)
    } else if (token.startsWith('# branch.ab ')) {
      const [ahead, behind] = token.slice(12).split(' ')
      status.ahead = Math.abs(Number(ahead))
      status.behind = Math.abs(Number(behind))
    } else if (token.startsWith('1 ') || token.startsWith('2 ')) {
      const [x, y] = token.slice(2, 4)
      if (x !== '.') status.staged++
      if (y !== '.') status.unstaged++
      if (token.startsWith('2 ')) i++ // the rename's source path is its own token
    } else if (token.startsWith('u ')) {
      status.conflicts++
    } else if (token.startsWith('? ')) {
      status.untracked++
    }
  }
  return status
}

export async function readStatus(at: string | Loc, signal?: AbortSignal): Promise<RepoStatus> {
  const [out, remotes, { gitDir }] = await Promise.all([
    git(at, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], signal),
    remoteNames(at),
    gitDirs(at)
  ])
  return { ...parseStatus(out), operation: await operationInProgress(toLoc(at), gitDir), remotes }
}

const MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']

/** Which marker files of a stopped operation are in the git dir (one `ls` on an SSH host). */
export async function markersIn(loc: Loc, gitDir: string): Promise<string[]> {
  if (loc.ssh) {
    const entries = await remoteEntries(loc, gitDir)
    return MARKERS.filter((name) => entries.has(name))
  }
  const present = await Promise.all(
    MARKERS.map((name) =>
      access(join(gitDir, name)).then(
        () => true,
        () => false
      )
    )
  )
  return MARKERS.filter((_, i) => present[i])
}

/** Which multi-step operation is stopped, from the marker files git leaves in the git dir. */
async function operationInProgress(loc: Loc, gitDir: string): Promise<Operation | null> {
  const markers = new Set(await markersIn(loc, gitDir))
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = MARKERS.map((name) => markers.has(name))
  if (rebaseMerge || rebaseApply) return 'rebase'
  if (merge) return 'merge'
  if (cherryPick) return 'cherry-pick'
  if (revert) return 'revert'
  return null
}

/** The git version where the repository is: `-C` needs a folder, and the repo's is at hand. */
export async function gitVersion(at: string | Loc = '.'): Promise<string> {
  return (await git(at, ['--version'])).trim()
}

export async function remoteNames(at: string | Loc): Promise<string[]> {
  return (await git(at, ['remote'])).split(/\r?\n/).filter(Boolean)
}

/** Whether `name` is already a local branch (remote-tracking refs do not count). */
export async function hasLocalBranch(at: string | Loc, name: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(at, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { timeoutMs: 10_000, signal })
  return result.code === 0
}

/** Splits a `%D` decoration list into typed refs. */
export function parseRefs(decorations: string, remotes: readonly string[]): Ref[] {
  if (!decorations) return []
  return decorations.split(', ').flatMap((raw): Ref[] => {
    if (raw.startsWith('HEAD -> ')) return [{ name: raw.slice(8), kind: 'head' }]
    if (raw === 'HEAD') return [{ name: 'HEAD', kind: 'detached' }]
    if (raw.startsWith('tag: ')) return [{ name: raw.slice(5), kind: 'tag' }]
    // origin/HEAD only says which branch the remote considers default; skip it like Git GUIs do.
    if (remotes.some((r) => raw === `${r}/HEAD`)) return []
    if (remotes.some((r) => raw.startsWith(`${r}/`))) return [{ name: raw, kind: 'remote' }]
    return [{ name: raw, kind: 'branch' }]
  })
}

export async function readCommits(
  cwd: string | Loc,
  opts: { skip: number; limit: number; remotes: readonly string[] },
  signal?: AbortSignal
): Promise<Commit[]> {
  let out: string
  try {
    out = await git(
      cwd,
      ['log', '--all', '--topo-order', `--skip=${opts.skip}`, `--max-count=${opts.limit}`, `--format=${FORMAT}`],
      signal
    )
  } catch (error) {
    // A repo with no commits yet has nothing to log.
    if (/does not have any commits|bad default revision/i.test((error as Error).message)) return []
    throw error
  }
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, parents, author, at, refs, subject] = record.split(FIELD)
      return {
        hash,
        shortHash,
        parents: parents ? parents.split(' ') : [],
        author,
        authoredAt: Number(at) * 1000,
        subject,
        refs: parseRefs(refs, opts.remotes)
      }
    })
}

// hash, parents, author name/email/time, committer name/email/time, then the raw message last
// (it may contain anything, so everything after the 8th separator is the message).
const DETAILS_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f')
const STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X'])

/**
 * Parses `git diff-tree -r -z --raw --numstat` output: every raw record first
 * (`:modes shas status\0path\0[dst\0]`), then the numstat records in the same order
 * (`added\tdeleted\tpath\0` or, for renames, `added\tdeleted\t\0src\0dst\0`).
 */
export function parseDiffTree(out: string): FileChange[] {
  const tokens = out.split('\0')
  const files: FileChange[] = []
  const stats: Array<[number | null, number | null]> = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i++]
    if (token === '') continue
    if (token.startsWith(':')) {
      const code = token.slice(1).split(' ')[4] ?? 'X'
      const letter = code[0]
      const status = (STATUSES.has(letter) ? letter : 'X') as FileStatus
      const first = tokens[i++]
      if (status === 'R' || status === 'C') files.push({ status, from: first, path: tokens[i++], added: null, deleted: null })
      else files.push({ status, path: first, added: null, deleted: null })
      continue
    }
    const [added, deleted, path] = token.split('\t')
    if (path === '') i += 2 // rename: source and destination follow as their own tokens
    const count = (n: string) => (n === '-' ? null : Number(n))
    stats.push([count(added), count(deleted)])
  }
  stats.forEach(([added, deleted], n) => {
    if (files[n]) Object.assign(files[n], { added, deleted })
  })
  return files
}

export async function readCommitDetails(
  cwd: string | Loc,
  hash: string,
  maxFiles: number,
  signal?: AbortSignal
): Promise<CommitDetails> {
  const out = await git(cwd, ['show', '-s', '--no-show-signature', `--format=${DETAILS_FORMAT}`, hash], signal)
  const fields = out.split(FIELD)
  const [full, parents, author, authorEmail, at, committer, committerEmail, ct] = fields
  const parentList = parents ? parents.split(' ') : []
  const comparedTo = parentList[0] ?? null
  // Merges are compared with their first parent, the root commit with the empty tree.
  const range = comparedTo ? [comparedTo, full] : ['--root', full]
  const diff = await git(cwd, ['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-commit-id', ...range], signal)
  const files = parseDiffTree(diff)
  return {
    hash: full,
    parents: parentList,
    author,
    authorEmail,
    authoredAt: Number(at) * 1000,
    committer,
    committerEmail,
    committedAt: Number(ct) * 1000,
    message: fields.slice(8).join(FIELD).replace(/\s+$/, ''),
    comparedTo,
    files: files.slice(0, maxFiles),
    filesTruncated: files.length > maxFiles
  }
}

/** Reads one file's patch against a commit's first parent (or the empty tree for a root commit). */
export async function readCommitFileDiff(
  cwd: string | Loc,
  hash: string,
  path: string,
  maxChars: number,
  signal?: AbortSignal
): Promise<FileDiff> {
  const parents = (await git(cwd, ['show', '-s', '--format=%P', hash], signal)).trim().split(' ').filter(Boolean)
  const range = parents[0] ? [parents[0], hash] : ['--root', hash]
  const patch = await git(cwd, ['diff-tree', '-r', '--no-commit-id', '-M', '-p', ...range, '--', path], signal)
  if (/(^|\n)(Binary files |GIT binary patch)/.test(patch)) return { kind: 'binary' }
  return { kind: 'text', patch: patch.slice(0, maxChars), truncated: patch.length > maxChars }
}

// Untracked files have no numstat; count their lines here, up to this size.
const MAX_COUNTED_BYTES = 1024 * 1024

/** Lines in a new file, or null when it looks binary, is too big or can't be read. */
async function countLines(path: string): Promise<number | null> {
  try {
    const { size } = await stat(path)
    if (size > MAX_COUNTED_BYTES) return null
    const data = await readFile(path)
    if (data.includes(0)) return null
    if (data.length === 0) return 0
    let lines = 0
    for (const byte of data) if (byte === 10) lines++
    return data[data.length - 1] === 10 ? lines : lines + 1
  } catch {
    return null
  }
}

/**
 * Everything not committed yet: staged and unstaged changes against HEAD in one diff (like
 * `git diff HEAD`), then the untracked files that `.gitignore` doesn't exclude.
 */
export async function readWorktreeChanges(cwd: string | Loc, maxFiles: number, signal?: AbortSignal): Promise<WorktreeChanges> {
  const [head, diff, others, top] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', 'HEAD'], signal),
    git(cwd, ['diff', 'HEAD', '-z', '-M', '--raw', '--numstat'], signal),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/'], signal),
    git(cwd, ['rev-parse', '--show-toplevel'], signal)
  ])
  const files = parseDiffTree(diff)
  const untracked = others.split('\0').filter(Boolean)
  const room = Math.max(0, maxFiles - files.length)
  const counted = await Promise.all(
    untracked.slice(0, room).map(async (path): Promise<FileChange> => {
      // Over SSH each file would cost a round trip, so untracked files there come without counts.
      const added = toLoc(cwd).ssh ? null : await countLines(join(top.trim(), path))
      return { status: 'A', path, added, deleted: added === null ? null : 0, untracked: true }
    })
  )
  const all = files.concat(counted)
  return {
    head: head.trim(),
    files: all.slice(0, maxFiles),
    filesTruncated: files.length + untracked.length > maxFiles
  }
}

/** The worktree's own git dir (HEAD, index) and the shared one (refs, packed-refs). */
export async function gitDirs(cwd: string | Loc): Promise<{ gitDir: string; commonDir: string }> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  const [gitDir, commonDir] = out.trim().split(/\r?\n/)
  return { gitDir, commonDir }
}

export async function currentBranch(cwd: string | Loc): Promise<string | null> {
  const out = (await git(cwd, ['branch', '--show-current'])).trim()
  return out.length > 0 ? out : null
}
