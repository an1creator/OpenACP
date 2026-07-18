import type { IChannelAdapter as CliChannelAdapter } from '@n1creator/openacp-cli'
import type { IChannelAdapter as SdkChannelAdapter } from '@n1creator/openacp-plugin-sdk'

const legacyAdapter = {
  name: 'legacy',
  capabilities: {
    streaming: false,
    richFormatting: false,
    threads: true,
    reactions: false,
    fileUpload: false,
    voice: false,
  },
  async start() {},
  async stop() {},
  async sendMessage() {},
  async sendPermissionRequest() {},
  async sendNotification() {},
  async createSessionThread() { return 'thread-1' },
  async renameSessionThread() {},
} satisfies CliChannelAdapter & SdkChannelAdapter

const transactionalThreadAdapter = {
  ...legacyAdapter,
  async deleteSessionThreadById(threadId: string) {
    void threadId
  },
} satisfies CliChannelAdapter & SdkChannelAdapter

function cleanupPreCreatedThread(adapter: CliChannelAdapter & SdkChannelAdapter): void {
  if (adapter.deleteSessionThreadById) {
    void adapter.deleteSessionThreadById('thread-1')
  }
}

cleanupPreCreatedThread(transactionalThreadAdapter)
