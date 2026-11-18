import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampColumnWidth } from './columns.ts'

test('clamps a resized graph column to the graph minimum', () => {
  assert.equal(clampColumnWidth('graph', 40, 84), 84)
  assert.equal(clampColumnWidth('date', 80, 84), 150)
  assert.equal(clampColumnWidth('author', 160, 84), 160)
})
