export type ColumnName = 'graph' | 'description' | 'date' | 'author' | 'commit'

const MIN: Record<ColumnName, number> = { graph: 0, description: 240, date: 150, author: 120, commit: 90 }

export function clampColumnWidth(column: ColumnName, width: number, graphMinimum = 0): number {
  return Math.max(column === 'graph' ? graphMinimum : MIN[column], Math.round(width))
}
