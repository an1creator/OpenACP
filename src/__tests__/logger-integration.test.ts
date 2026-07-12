import { describe, it, expect, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, createSessionLogger, closeSessionLogger, cleanupOldSessionLogs, log } from '../core/utils/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('logger integration', () => {
  let tmpDir: string

  afterEach(async () => {
    await shutdownLogger()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full lifecycle: init → child → session → cleanup → shutdown', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-int-'))
    const logDir = path.join(tmpDir, 'logs')

    // 1. Init
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    // 2. Module child logger
    const coreLog = createChildLogger({ module: 'core' })
    coreLog.info('core started')

    // 3. Session logger
    const sessionLog = createSessionLogger('integration-sess', coreLog)
    sessionLog.info({ promptLength: 42 }, 'Prompt queued')
    sessionLog.warn('something iffy')
    sessionLog.error({ err: new Error('test error') }, 'Prompt failed')

    // 4. Close the per-session destination and root worker deterministically.
    await closeSessionLogger(sessionLog)
    await cleanupOldSessionLogs(30)
    await shutdownLogger()

    // 5. Verify combined log
    const combinedFile = fs.readdirSync(logDir).find(f => f.startsWith('openacp'))
    expect(combinedFile).toBeDefined()
    const combined = fs.readFileSync(path.join(logDir, combinedFile!), 'utf-8')
    expect(combined).toContain('core started')
    expect(combined).toContain('Prompt queued')
    expect(combined).toContain('Prompt failed')

    // 6. Verify session log
    const sessionFile = path.join(logDir, 'sessions', 'integration-sess.log')
    expect(fs.existsSync(sessionFile)).toBe(true)
    const sessionContent = fs.readFileSync(sessionFile, 'utf-8')
    expect(sessionContent).toContain('Prompt queued')
    expect(sessionContent).toContain('integration-sess')

    // 7. Cleanup ran before shutdown and should not delete the fresh file.
    expect(fs.existsSync(sessionFile)).toBe(true)
  })

  it('gracefully degrades if log dir is not writable', () => {
    // /dev/null/subdir cannot be created on any platform
    expect(() => {
      initLogger({ level: 'info', logDir: '/dev/null/openacp-test-log', maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })
    }).not.toThrow()
  })
})
