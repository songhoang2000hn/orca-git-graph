import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampColumnWidth, resolveColumnWidths } from './columns.ts'

test('clamps a resized graph column to the graph minimum', () => {
  assert.equal(clampColumnWidth('graph', 40, 84), 84)
  assert.equal(clampColumnWidth('date', 80, 84), 150)
  assert.equal(clampColumnWidth('author', 160, 84), 160)
})

test('uses one fixed track width for every commit row and the header', () => {
  assert.deepEqual(resolveColumnWidths(1_000, {}, 84), {
    graph: 84,
    description: 476,
    date: 180,
    author: 160,
    commit: 100
  })
})
