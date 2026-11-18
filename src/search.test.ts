import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findCommitHashes } from './search.ts'
import type { Commit } from './types.ts'

const commits: Commit[] = [
  { hash: 'a1b2c3d4', shortHash: 'a1b2c3d', parents: [], author: 'Song Hoang', authoredAt: 1, subject: 'Add search', refs: [{ kind: 'branch', name: 'main' }] },
  { hash: 'e5f6a7b8', shortHash: 'e5f6a7b', parents: [], author: 'Alex', authoredAt: 2, subject: 'Fix styling', refs: [{ kind: 'tag', name: 'v1.0.0' }] }
]

test('finds loaded commits by subject, author, hash and ref name', () => {
  assert.deepEqual(findCommitHashes(commits, 'search'), ['a1b2c3d4'])
  assert.deepEqual(findCommitHashes(commits, 'song'), ['a1b2c3d4'])
  assert.deepEqual(findCommitHashes(commits, 'e5f6'), ['e5f6a7b8'])
  assert.deepEqual(findCommitHashes(commits, 'v1.0.0'), ['e5f6a7b8'])
})
