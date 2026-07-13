import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyService } from '../../network/proxy-service.js'
import { stageNpmPlugin } from '../plugin-installer.js'

describe('plugin installer dynamic scoped child env', () => {
  let root: string | undefined
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })

  it('passes rotated plugin-installer policy to each real npm child process', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-plugin-env-'))
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    const fakeNpm = path.join(bin, 'npm')
    fs.writeFileSync(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
prefix=''
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do if [[ "\${args[$i]}" == '--prefix' ]]; then prefix="\${args[$((i+1))]}"; fi; done
mkdir -p "$prefix/node_modules/fake-tts"
printf '{"name":"fake-tts","version":"1.0.0","type":"module","main":"index.js"}' > "$prefix/node_modules/fake-tts/package.json"
printf 'export default {name:"fake-tts",version:"1.0.0",setup:async()=>{},install:async()=>{}}\n' > "$prefix/node_modules/fake-tts/index.js"
printf '%s' "\${HTTPS_PROXY:-missing}" > "$prefix/seen-proxy.txt"
`, { mode: 0o700 })
    const service = new ProxyService(root)
    service.saveProfile({ id: 'speech', protocol: 'http', host: 'old.test', port: 8080 })
    await service.setRoute('services.pluginInstaller', 'profile:speech')
    const inherited = { ...process.env, PATH: `${bin}:${process.env.PATH}` } as Record<string, string>
    const first = path.join(root, 'first')
    const firstStage = await stageNpmPlugin('fake-tts', first, service.buildChildEnv('services.pluginInstaller', inherited))
    await service.saveProfileSafely({ id: 'speech', protocol: 'http', host: 'new.test', port: 9090 })
    const second = path.join(root, 'second')
    const secondStage = await stageNpmPlugin('fake-tts', second, service.buildChildEnv('services.pluginInstaller', inherited))
    expect(fs.readFileSync(path.join(firstStage.stageDir, 'seen-proxy.txt'), 'utf8')).toContain('old.test:8080')
    expect(fs.readFileSync(path.join(secondStage.stageDir, 'seen-proxy.txt'), 'utf8')).toContain('new.test:9090')
    await firstStage.discard(); await secondStage.discard()
  })
})
