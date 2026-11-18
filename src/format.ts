/** Formats a commit time for the graph's Date column. */
export function formatCommitDate(at: number, locale?: string, timeZone?: string): string {
  const options = timeZone ? { timeZone } : {}
  const date = new Date(at)
  const day = new Intl.DateTimeFormat(locale ?? 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...options }).format(date)
  const time = new Intl.DateTimeFormat(locale ?? 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...options }).format(date)
  return `${day} ${time}`
}
