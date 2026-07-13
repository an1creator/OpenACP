import type { DoctorReport } from './types.js'

function countNoun(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function doctorHeadline(summary: DoctorReport['summary']): string {
  if (summary.failed === 1) return '1 failure needs attention'
  if (summary.failed > 1) return `${summary.failed} failures need attention`
  if (summary.warnings > 0) return `${countNoun(summary.warnings, 'warning', 'warnings')} to review`
  return 'All checks passed'
}

export function doctorSummary(summary: DoctorReport['summary'], separator = ', '): string {
  const counts = [
    `${summary.passed} passed`,
    countNoun(summary.warnings, 'warning', 'warnings'),
    countNoun(summary.failed, 'failure', 'failures'),
  ]
  if (summary.fixed) counts.push(countNoun(summary.fixed, 'fix', 'fixes'))
  return counts.join(separator)
}
