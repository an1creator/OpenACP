import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initLogger, shutdownLogger, createChildLogger, log } from '../core/utils/log.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('logger', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-log-test-'))
  })

  afterEach(async () => {
    await shutdownLogger()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('default log instance works before initLogger (console-only)', () => {
    expect(() => log.info('test message')).not.toThrow()
  })

  it('initLogger creates log directory and file', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    log.info('hello from test')

    // Flush by shutting down transport (proper flush instead of setTimeout)
    await shutdownLogger()

    expect(fs.existsSync(logDir)).toBe(true)
    const files = fs.readdirSync(logDir)
    expect(files.some(f => f.startsWith('openacp'))).toBe(true)
  })

  it('createChildLogger adds module context', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'debug', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    const childLog = createChildLogger({ module: 'test-module' })
    childLog.info('child message')

    await shutdownLogger()

    const files = fs.readdirSync(logDir).filter(f => f.startsWith('openacp'))
    expect(files.length).toBeGreaterThan(0)
    const logFile = files[0]
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8')
    const lines = content.trim().split('\n').map(l => JSON.parse(l))
    const entry = lines.find((l: any) => l.msg === 'child message')
    expect(entry).toBeDefined()
    expect(entry.module).toBe('test-module')
  })

  it('log wrapper supports variadic args for backward compat', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    log.info('loaded from', '/some/path')

    await shutdownLogger()

    const files = fs.readdirSync(logDir).filter(f => f.startsWith('openacp'))
    expect(files.length).toBeGreaterThan(0)
    const logFile = files[0]
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8')
    expect(content).toContain('loaded from /some/path')
  })

  it('respects log level', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'warn', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })

    log.info('should not appear')
    log.warn('should appear')

    await shutdownLogger()

    const files = fs.readdirSync(logDir).filter(f => f.startsWith('openacp'))
    expect(files.length).toBeGreaterThan(0)
    const logFile = files[0]
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8')
    expect(content).not.toContain('should not appear')
    expect(content).toContain('should appear')
  })

  it('redacts network credentials from structured errors, URLs, and headers', async () => {
    const logDir = path.join(tmpDir, 'logs')
    initLogger({ level: 'info', logDir, maxFileSize: '10m', maxFiles: 7, sessionLogRetentionDays: 30 })
    const token = '123456789:AALogSecret_123'
    const child = createChildLogger({ module: 'security-test' })
    child.error({
      err: new Error(`request to https://api.telegram.org/bot${token}/getMe failed`),
      url: 'http://proxy-user:proxy-pass@proxy.example:8080/?api_key=query-secret',
      headers: { authorization: 'Bearer header-secret', cookie: 'session=cookie-secret' },
    }, 'network failure')
    await shutdownLogger()

    const file = fs.readdirSync(logDir).find((name) => name.startsWith('openacp'))!
    const content = fs.readFileSync(path.join(logDir, file), 'utf8')
    for (const secret of [token, 'proxy-user', 'proxy-pass', 'query-secret', 'header-secret', 'cookie-secret']) {
      expect(content).not.toContain(secret)
    }
    expect(content).toContain('api.telegram.org/bot<redacted>/getMe')
    expect(content).toContain('proxy.example:8080')
  })
})
