import type { DoctorCheck } from '../types.js'
import { PROXY_ENV_KEYS } from '../../network/proxy-service.js'
import { ProxyStore, ProxyStoreCorruptError } from '../../network/proxy-store.js'

export const proxyCheck: DoctorCheck = {
  name: 'Proxy routing',
  order: 85,
  async run(ctx) {
    try { if (ctx.dataDir) new ProxyStore(ctx.dataDir).load() }
    catch (error) {
      if (error instanceof ProxyStoreCorruptError) return [{ status: 'fail', message: `${error.message}. Network consumers are fail-closed; inspect quarantine/LKG before recovery.` }]
      throw error
    }
    const variables = PROXY_ENV_KEYS.filter((key) => {
      const value = process.env[key]
      return !['NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'].includes(key) && value !== undefined && value !== ''
    })
    if (!variables.length) {
      return [{ status: 'pass', message: 'No daemon-wide proxy environment; native scoped routing is authoritative' }]
    }
    return [{
      status: 'warn',
      message: `Daemon-wide proxy environment active (${variables.join(', ')}); scoped routing is in compatibility mode until legacy wrapper/drop-in injection is removed`,
    }]
  },
}
