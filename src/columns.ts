export type ColumnName = 'graph' | 'description' | 'date' | 'author' | 'commit'

const MIN: Record<ColumnName, number> = { graph: 0, description: 240, date: 150, author: 120, commit: 90 }
const DEFAULT: Record<ColumnName, number> = { graph: 0, description: 240, date: 180, author: 160, commit: 100 }

export function clampColumnWidth(column: ColumnName, width: number, graphMinimum = 0): number {
  return Math.max(column === 'graph' ? graphMinimum : MIN[column], Math.round(width))
}

/**
 * Rows are individual grids, so each track must resolve to the same pixel value.
 * The un-resized Description column takes the remaining viewport width; every
 * resized column keeps its explicitly chosen width and may make the list scroll.
 */
export function resolveColumnWidths(
  availableWidth: number,
  saved: Partial<Record<ColumnName, number>>,
  graphMinimum = 0
): Record<ColumnName, number> {
  const graph = clampColumnWidth('graph', saved.graph ?? Math.max(DEFAULT.graph, graphMinimum), graphMinimum)
  const date = clampColumnWidth('date', saved.date ?? DEFAULT.date)
  const author = clampColumnWidth('author', saved.author ?? DEFAULT.author)
  const commit = clampColumnWidth('commit', saved.commit ?? DEFAULT.commit)
  const description = saved.description === undefined
    ? Math.max(MIN.description, Math.round(availableWidth) - graph - date - author - commit)
    : clampColumnWidth('description', saved.description)
  return { graph, description, date, author, commit }
}
