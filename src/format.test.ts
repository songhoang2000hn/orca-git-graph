import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCommitDate } from './format.ts'

test('formats a commit timestamp as an absolute date and time', () => {
  assert.equal(formatCommitDate(Date.UTC(2026, 10, 18, 10, 47), 'en-GB', 'UTC'), '18 Nov 2026 10:47')
})
