import { describe, expect, it } from 'vitest'
import { doctorHeadline, doctorSummary } from '../format.js'

describe('doctor human count grammar', () => {
  it('uses singular nouns and verb agreement for one result', () => {
    const summary = { passed: 1, warnings: 1, failed: 1, fixed: 1 }
    expect(doctorHeadline(summary)).toBe('1 failure needs attention')
    expect(doctorSummary(summary)).toBe('1 passed, 1 warning, 1 failure, 1 fix')
  })

  it('uses plural nouns for zero and multiple results', () => {
    const summary = { passed: 2, warnings: 0, failed: 2, fixed: 2 }
    expect(doctorHeadline(summary)).toBe('2 failures need attention')
    expect(doctorSummary(summary)).toBe('2 passed, 0 warnings, 2 failures, 2 fixes')
  })
})
