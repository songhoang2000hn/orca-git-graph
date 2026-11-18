// Best-effort reads of Orca's own desktop state, for what the plugin host API does not say:
// which ssh alias reaches a remote host, and which folder a remote workspace is. Orca does not
// list some remote workspaces (hosts running its managed server, `runtime:<env>`) to plugins.
// Everything here is read-only and optional: when the files move or change shape, the panel
// asks the person for the ssh destination instead. (Idea from dennib/finline PR #1.)
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Orca's userData folder on this platform. */
function orcaDataDir(): string {
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'orca')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'orca')
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'orca')
}

function sqliteDocument(db: string, domain: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'sqlite3',
      ['-readonly', db, `SELECT payload FROM profile_state_documents WHERE domain = '${domain}';`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout))
    )
  })
}

/** `sshTargets` rows to `ssh:<id>` → the alias ssh resolves (config host, else host name). */
export function parseSshTargets(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const targets = JSON.parse(raw.trim()) as Array<{ id?: string; configHost?: string; host?: string; username?: string; port?: number }>
    for (const t of Array.isArray(targets) ? targets : []) {
      if (!t.id) continue
      const alias = t.configHost || (t.host ? `${t.username ? `${t.username}@` : ''}${t.host}` : '')
      if (alias) map.set(`ssh:${t.id}`, alias)
    }
  } catch {
    // Unknown shape: no aliases.
  }
  return map
}

/** Managed-server environments (`runtime:<env>`) deployed over an ssh target take its alias. */
export function addEnvironments(raw: string, map: Map<string, string>): void {
  try {
    const sidecar = JSON.parse(raw) as { entries?: Record<string, { orcadDeployment?: { sshTargetId?: string } }> }
    for (const [env, entry] of Object.entries(sidecar.entries ?? {})) {
      const alias = map.get(`ssh:${entry.orcadDeployment?.sshTargetId ?? ''}`)
      if (alias) map.set(`runtime:${env}`, alias)
    }
  } catch {
    // Unknown shape: no environments.
  }
}

/** The focused workspace of each remote host, from `workspaceSessionsByHostId`. */
export function parseActiveRemote(raw: string, aliases: Map<string, string>): Array<{ hostId: string; alias: string | null; path: string }> {
  try {
    const sessions = JSON.parse(raw.trim()) as Record<string, { activeWorktreeId?: string }>
    return Object.entries(sessions).flatMap(([key, session]) => {
      const id = session?.activeWorktreeId
      const path = id?.includes('::') ? id.split('::').slice(1).join('::') : null
      if (key === 'local' || !path) return []
      const hostId = key.startsWith('ssh:') || key.startsWith('runtime:') ? key : `runtime:${key}`
      return [{ hostId, alias: aliases.get(hostId) ?? null, path }]
    })
  } catch {
    return []
  }
}

export interface OrcaState {
  /** Orca host id (`ssh:…`, `runtime:…`) → ssh alias. */
  aliases: Map<string, string>
  /** The workspace each remote host has focused. */
  activeRemote: Array<{ hostId: string; alias: string | null; path: string }>
}

let cached: { at: number; state: OrcaState } | null = null

/** Reads Orca's state, at most every few seconds; empty when it can't be read. */
export async function readOrcaState(): Promise<OrcaState> {
  if (cached && Date.now() - cached.at < 3000) return cached.state
  const dir = orcaDataDir()
  const db = join(dir, 'profiles', 'local-default', 'profile-state.db')
  const aliases = parseSshTargets(await sqliteDocument(db, 'sshTargets').catch(() => '[]'))
  addEnvironments(await readFile(join(dir, 'orca-environment-sidecar.json'), 'utf8').catch(() => '{}'), aliases)
  const activeRemote = parseActiveRemote(await sqliteDocument(db, 'workspaceSessionsByHostId').catch(() => '{}'), aliases)
  const state = { aliases, activeRemote }
  cached = { at: Date.now(), state }
  return state
}
