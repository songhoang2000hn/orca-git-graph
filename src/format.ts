/** Formats a commit time for the graph's Date column. */
export function formatCommitDate(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {})
  }).format(new Date(at))
}
