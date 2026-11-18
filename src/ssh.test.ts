import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  git,
  isSshTarget,
  markersIn,
  readCommits,
  readStatus,
  readWorktreeChanges,
  runGit,
  shellQuote,
  sshArgs,
  SshError,
  type Loc
} from './git.ts'

test('ssh destinations are aliases or user@host, never options or shell words', () => {
  for (const ok of ['k6', 'me@example.com', 'me@10.0.0.2', 'host.local', 'user@[::1]']) assert.ok(isSshTarget(ok), ok)
  for (const bad of ['', '-oProxyCommand=x', 'a b', 'a;b', 'a$(x)', "a'b", 'a\nb']) assert.ok(!isSshTarget(bad), bad)
})

test('shellQuote leaves plain words and single-quotes the rest', () => {
  assert.equal(shellQuote('--format=%H%x1f'), '--format=%H%x1f')
  assert.equal(shellQuote('/home/me/my repo'), "'/home/me/my repo'")
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote('$(rm -rf ~)'), "'$(rm -rf ~)'")
  assert.equal(shellQuote(''), "''")
})

test('sshArgs never prompts and puts the destination after --', () => {
  const args = sshArgs('k6', ['git', '-C', '/srv/a b', 'log'])
  assert.ok(args.includes('BatchMode=yes'))
  const dash = args.indexOf('--')
  assert.deepEqual(args.slice(dash), ['--', 'k6', "git -C '/srv/a b' log"])
})

/**
 * A stand-in `ssh` on PATH that runs the remote command with `sh -c` here, the way a POSIX
 * login shell on the host would, so the quoting is exercised for real.
 */
async function fakeSsh(dir: string): Promise<string> {
  const bin = join(dir, 'bin')
  await mkdir(bin)
  const script = [
    '#!/bin/sh',
    // drop options up to "--", then the destination; "down" plays an unreachable host
    'while [ "$1" != "--" ]; do shift; done; shift',
    'if [ "$1" = "down" ]; then echo "ssh: connect to host down: Connection refused" >&2; exit 255; fi',
    'shift',
    'exec sh -c "$1"'
  ].join('\n')
  await writeFile(join(bin, 'ssh'), script + '\n')
  await chmod(join(bin, 'ssh'), 0o755)
  return bin
}

test('git runs on an SSH host through ssh, with paths and arguments quoted', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-ssh-'))
  const savedPath = process.env.PATH
  try {
    process.env.PATH = `${await fakeSsh(dir)}:${savedPath}`
    const repo = join(dir, "the repo's folder") // a space and a quote in the remote path
    await mkdir(repo)
    const loc: Loc = { path: repo, ssh: 'fake-host' }
    const run = (...args: string[]) => git(loc, args)
    await run('init', '-q', '-b', 'main')
    await run('config', 'user.email', 'test@example.com')
    await run('config', 'user.name', 'Test')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await run('add', '.')
    await run('commit', '-q', '-m', 'first: $(echo not run) `x`')
    await writeFile(join(repo, 'new.txt'), 'x\n')

    const commits = await readCommits(loc, { skip: 0, limit: 10, remotes: [] })
    assert.equal(commits.length, 1)
    assert.equal(commits[0].subject, 'first: $(echo not run) `x`')
    assert.deepEqual(commits[0].refs, [{ name: 'main', kind: 'head' }])

    const status = await readStatus(loc)
    assert.equal(status.branch, 'main')
    assert.equal(status.untracked, 1)
    assert.equal(status.operation, null)

    const changes = await readWorktreeChanges(loc, 100)
    // Untracked files on a host come without line counts (one round trip each otherwise).
    assert.deepEqual(changes.files, [{ status: 'A', path: 'new.txt', added: null, deleted: null, untracked: true }])

    // Actions get their no-prompt environment on the host too.
    const env = await runGit(loc, ['var', 'GIT_EDITOR'], { timeoutMs: 10_000 })
    assert.equal(env.code, 0)
    assert.equal(env.stdout.trim(), 'true')

    await writeFile(join(repo, '.git', 'MERGE_HEAD'), commits[0].hash + '\n')
    assert.deepEqual(await markersIn(loc, join(repo, '.git')), ['MERGE_HEAD'])
  } finally {
    process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreachable SSH host is an SshError, not a git failure', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-ssh-'))
  const savedPath = process.env.PATH
  try {
    process.env.PATH = `${await fakeSsh(dir)}:${savedPath}`
    const loc: Loc = { path: '/srv/repo', ssh: 'down' }
    await assert.rejects(git(loc, ['status']), (error) => error instanceof SshError && /Connection refused/.test(error.message))
    const result = await runGit(loc, ['fetch'], { timeoutMs: 10_000 })
    assert.equal(result.code, 255)
    assert.match(result.stderr, /^ssh down failed: .*Connection refused/)
  } finally {
    process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('Orca state gives ssh aliases for ssh and managed-server hosts, and each host’s focused folder', async () => {
  const { addEnvironments, parseActiveRemote, parseSshTargets } = await import('./orca-state.ts')
  const aliases = parseSshTargets(
    JSON.stringify([
      { id: 't1', label: 'Mac Studio', configHost: 'studio', host: '10.0.0.5', port: 22, username: 'me' },
      { id: 't2', label: 'Box', host: 'box.lan', port: 22, username: 'pt' }
    ])
  )
  assert.equal(aliases.get('ssh:t1'), 'studio')
  assert.equal(aliases.get('ssh:t2'), 'pt@box.lan')
  addEnvironments(JSON.stringify({ entries: { env9: { orcadDeployment: { sshTargetId: 't1' } } } }), aliases)
  assert.equal(aliases.get('runtime:env9'), 'studio')
  const active = parseActiveRemote(
    JSON.stringify({
      local: { activeWorktreeId: 'r0::/Users/me/x' },
      'runtime:env9': { activeWorktreeId: 'r1::/Users/me/projects/scms' }
    }),
    aliases
  )
  assert.deepEqual(active, [{ hostId: 'runtime:env9', alias: 'studio', path: '/Users/me/projects/scms' }])
  assert.equal(parseSshTargets('not json').size, 0)
})

test('the Orca CLI list of a host parses to name, short branch and folder', async () => {
  const { parseHostWorktrees } = await import('./git.ts')
  const out = JSON.stringify({
    ok: true,
    result: { worktrees: [{ displayName: 'fix/a', branch: 'refs/heads/fix/a', path: '/srv/repo' }, { displayName: 'x', branch: '', path: '/srv/x' }] }
  })
  assert.deepEqual(parseHostWorktrees(out), [
    { displayName: 'fix/a', branch: 'fix/a', path: '/srv/repo' },
    { displayName: 'x', branch: null, path: '/srv/x' }
  ])
  assert.throws(() => parseHostWorktrees('{"ok":false}'))
})
