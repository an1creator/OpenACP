import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectDaemonProxyEnvironment, proxyCheck } from '../checks/proxy.js'
import { PROXY_ENV_KEYS } from '../../network/proxy-service.js'
import { writeDaemonIdentity } from '../../instance/daemon-identity.js'

describe('proxy doctor check', () => {
  const original = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('warns without exposing values when the known daemon environment has proxy variables', async () => {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    const [result] = await proxyCheck.run({
      daemonProxyEnvironment: { state: 'known', variableNames: ['HTTP_PROXY'], source: 'proc' },
    } as any)
    expect(result.status).toBe('warn')
    expect(result.message).toContain('running OpenACP daemon')
    expect(result.message).toContain('HTTP_PROXY')
    expect(result.message).toContain('Compatibility mode')
  })

  it('does not misdiagnose caller-only proxy variables as daemon compatibility mode', async () => {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    process.env.HTTP_PROXY = 'http://user:secret@proxy.invalid:8080'
    const [result] = await proxyCheck.run({
      daemonProxyEnvironment: { state: 'known', variableNames: [], source: 'proc' },
    } as any)
    expect(result.status).toBe('pass')
    expect(result.message).toContain('Current command shell has proxy variables (HTTP_PROXY)')
    expect(result.message).toContain('not present in the running daemon')
    expect(result.message).not.toContain('Compatibility mode')
    expect(result.message).not.toContain('secret')
  })

  it('labels caller variables explicitly when the daemon environment is unavailable', async () => {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    process.env.HTTPS_PROXY = 'http://user:secret@proxy.invalid:8080'
    const [result] = await proxyCheck.run({
      daemonProxyEnvironment: { state: 'unavailable', variableNames: [], source: 'none' },
    } as any)
    expect(result.status).toBe('warn')
    expect(result.message).toContain('Current command shell has proxy variables (HTTPS_PROXY)')
    expect(result.message).toContain('compatibility mode was not inferred')
    expect(result.message).not.toContain('secret')
  })

  it('passes for a clean caller and a known clean daemon environment', async () => {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    process.env.NODE_USE_ENV_PROXY = '0'
    const [result] = await proxyCheck.run({
      daemonProxyEnvironment: { state: 'known', variableNames: [], source: 'proc' },
    } as any)
    expect(result.status).toBe('pass')
    expect(result.message).toContain('running daemon has no proxy variables')
  })

  it('does not infer daemon proxy variables from a foreign live PID without instance identity proof', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-foreign-pid-'))
    const pidPath = path.join(root, 'openacp.pid')
    const previous = process.env.HTTP_PROXY
    process.env.HTTP_PROXY = 'http://user:secret@foreign.invalid:8080'
    fs.writeFileSync(pidPath, String(process.pid))
    try {
      expect(inspectDaemonProxyEnvironment(pidPath, root)).toEqual({
        state: 'unavailable', variableNames: [], source: 'none',
      })
    } finally {
      if (previous === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'linux')('reports unavailable when an identified daemon environ cannot be read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-proc-denied-'))
    const pidPath = path.join(root, 'openacp.pid')
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ id: 'doctor-test' }))
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      env: { ...process.env, HTTP_PROXY: 'http://user:secret@daemon.invalid:8080' },
      stdio: 'ignore',
    })
    fs.writeFileSync(pidPath, String(child.pid))
    writeDaemonIdentity(pidPath, child.pid!)
    const originalRead = fs.readFileSync.bind(fs)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file) === `/proc/${child.pid}/environ`) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return (originalRead as any)(file, ...args)
    }) as typeof fs.readFileSync)
    try {
      expect(inspectDaemonProxyEnvironment(pidPath, root)).toEqual({
        state: 'unavailable', variableNames: [], source: 'none',
      })
    } finally {
      readSpy.mockRestore()
      child.kill('SIGKILL')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a corrupt policy store as fail-closed without replacing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-proxy-'))
    const config = path.join(root, 'proxy.json')
    fs.writeFileSync(config, '{broken', { mode: 0o600 })
    try {
      const [result] = await proxyCheck.run({ dataDir: root } as any)
      expect(result.status).toBe('fail')
      expect(result.message).toContain('blocked for safety')
      expect(fs.readFileSync(config, 'utf8')).toBe('{broken')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
