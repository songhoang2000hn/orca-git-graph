import { formatCommitDate } from './format.ts'
import type { Commit } from './types.ts'

/** Returns hashes of loaded commits whose visible metadata contains `query`. */
export function findCommitHashes(commits: readonly Commit[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  return commits
    .filter((commit) =>
      [commit.subject, commit.author, commit.hash, commit.shortHash, formatCommitDate(commit.authoredAt), ...commit.refs.map((ref) => ref.name)]
        .join('\n')
        .toLocaleLowerCase()
        .includes(needle)
    )
    .map((commit) => commit.hash)
}
