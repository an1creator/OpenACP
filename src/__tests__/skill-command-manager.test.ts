import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SkillCommandManager } from '../plugins/telegram/skill-command-manager.js'
import type { AgentCommand } from '../core/types.js'

const commandMocks = vi.hoisted(() => ({
  buildSkillMessages: vi.fn(),
  buildSkillKeyboard: vi.fn(),
}))

vi.mock('../plugins/telegram/commands/index.js', () => ({
  buildSkillMessages: commandMocks.buildSkillMessages,
  buildSkillKeyboard: commandMocks.buildSkillKeyboard,
}))

vi.mock('../../core/log.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

function mockBot() {
  let nextMessageId = 42
  return {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
      editMessageText: vi.fn().mockResolvedValue({}),
      deleteMessage: vi.fn().mockResolvedValue(true),
      pinChatMessage: vi.fn().mockResolvedValue(true),
      unpinChatMessage: vi.fn().mockResolvedValue(true),
    },
  } as any
}

function mockSendQueue() {
  return {
    enqueue: vi.fn(async (fn: () => Promise<any>) => fn()),
  } as any
}

function mockSessionManager(records: Record<string, any> = {}) {
  return {
    getSessionRecord: vi.fn((id: string) => records[id]),
    patchRecord: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (records[id]) records[id] = { ...records[id], ...structuredClone(patch) }
    }),
  } as any
}

describe('SkillCommandManager', () => {
  let manager: SkillCommandManager
  let bot: ReturnType<typeof mockBot>
  let sessionManager: ReturnType<typeof mockSessionManager>

  beforeEach(() => {
    commandMocks.buildSkillMessages.mockReset().mockImplementation((commands: AgentCommand[]) =>
      commands.length > 0 ? [`<b>Skills:</b>\n${commands.map(c => `/${c.name}`).join('\n')}`] : [],
    )
    commandMocks.buildSkillKeyboard.mockReset().mockImplementation((commands: AgentCommand[]) => ({
      inline_keyboard: commands.map((command) => [{
        text: `/${command.name}`,
        callback_data: `a/${command.name}`,
      }]),
    }))
    bot = mockBot()
    sessionManager = mockSessionManager()
    manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
  })

  describe('send()', () => {
    it('sends new skill commands message and pins it', async () => {
      const commands: AgentCommand[] = [
        { name: 'commit', description: 'Git commit' },
        { name: 'test', description: 'Run tests' },
      ]

      await manager.send('sess-1', 100, commands)

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        12345,
        expect.stringContaining('/commit'),
        expect.objectContaining({
          message_thread_id: 100,
          parse_mode: 'HTML',
          reply_markup: expect.any(Object),
        }),
      )
      expect(bot.api.pinChatMessage).toHaveBeenCalledWith(12345, 42, expect.any(Object))
    })

    it('persists skillMsgId to session record', async () => {
      sessionManager.getSessionRecord.mockReturnValue({
        sessionId: 'sess-1',
        platform: { topicId: 100 },
      })

      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      expect(sessionManager.patchRecord).toHaveBeenCalledWith('sess-1', {
        platform: expect.objectContaining({ skillMsgId: 42 }),
      })
    })

    it('edits existing message instead of sending new one', async () => {
      // First send
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // Second send — should edit
      await manager.send('sess-1', 100, [
        { name: 'test', description: 'Test' },
        { name: 'build', description: 'Build' },
      ])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.stringContaining('/test'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      )
    })

    it('calls cleanup when commands is empty', async () => {
      // First send so there's a message
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // Send empty — should cleanup
      await manager.send('sess-1', 100, [])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.stringContaining('Session ended'),
        expect.any(Object),
      )
    })

    it('restores skillMsgId from persisted platform data', async () => {
      sessionManager.getSessionRecord.mockReturnValue({
        sessionId: 'sess-1',
        platform: { topicId: 100, skillMsgId: 99 },
      })

      // Update should use persisted msgId
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        99,
        expect.any(String),
        expect.any(Object),
      )
    })

    it('handles edit failure by sending new message', async () => {
      // First send
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // Edit fails
      bot.api.editMessageText.mockRejectedValueOnce(new Error('message deleted'))

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      // Should have tried to delete old message and sent new one
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('handles "message is not modified" error gracefully', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      bot.api.editMessageText.mockRejectedValueOnce(new Error('message is not modified'))

      // Should not throw and should not send new message
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      // sendMessage should only have been called once (first time)
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('replaces one message with a complete multi-message set before retiring the old ID', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      await manager.send('sess-1', 100, [{ name: 'old', description: 'Old' }])
      commandMocks.buildSkillMessages.mockReturnValueOnce(['part 1', 'part 2', 'part 3'])

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      expect(records['sess-1'].platform).toMatchObject({
        skillMsgId: 43,
        skillMsgIds: [43, 44, 45],
        skillMsgDigest: expect.any(String),
      })
      expect(bot.api.pinChatMessage).toHaveBeenLastCalledWith(12345, 43, expect.any(Object))
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('replaces a multi-message set with one message and cleans every overflow ID', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      commandMocks.buildSkillMessages
        .mockReturnValueOnce(['old 1', 'old 2', 'old 3'])
        .mockReturnValueOnce(['new 1'])
      await manager.send('sess-1', 100, [{ name: 'old', description: 'Old' }])

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      expect(records['sess-1'].platform.skillMsgIds).toEqual([45])
      expect(bot.api.deleteMessage.mock.calls.map((call: unknown[]) => call[1]))
        .toEqual(expect.arrayContaining([42, 43, 44]))
    })

    it('replaces an N-part set with a different M-part set without mixing their IDs', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      commandMocks.buildSkillMessages
        .mockReturnValueOnce(['old 1', 'old 2'])
        .mockReturnValueOnce(['new 1', 'new 2', 'new 3'])
      await manager.send('sess-1', 100, [{ name: 'old', description: 'Old' }])

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      expect(records['sess-1'].platform.skillMsgIds).toEqual([44, 45, 46])
      expect(records['sess-1'].platform.skillStaleMsgIds).toBeUndefined()
      expect(bot.api.deleteMessage.mock.calls.map((call: unknown[]) => call[1]))
        .toEqual(expect.arrayContaining([42, 43]))
    })

    it('falls back from a failed atomic single-message edit to a staged replacement', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      await manager.send('sess-1', 100, [{ name: 'old', description: 'Old' }])
      bot.api.editMessageText.mockRejectedValueOnce(new Error('message cannot be edited'))

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      expect(records['sess-1'].platform.skillMsgIds).toEqual([43])
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2)
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('rolls back a partially sent replacement and keeps the old persisted set current', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      await manager.send('sess-1', 100, [{ name: 'old', description: 'Old' }])
      commandMocks.buildSkillMessages.mockReturnValueOnce(['new 1', 'new 2', 'new 3'])
      bot.api.sendMessage
        .mockResolvedValueOnce({ message_id: 43 })
        .mockRejectedValueOnce(new Error('rate limited'))

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      expect(records['sess-1'].platform.skillMsgIds).toEqual([42])
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 43)
      expect(bot.api.deleteMessage).not.toHaveBeenCalledWith(12345, 42)
      expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(1)
    })

    it('rolls back a fully staged replacement when persistence fails', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      await manager.send('sess-1', 100, [{ name: 'old', description: 'Old' }])
      commandMocks.buildSkillMessages.mockReturnValueOnce(['new 1', 'new 2'])
      sessionManager.patchRecord.mockRejectedValueOnce(new Error('disk full'))

      await manager.send('sess-1', 100, [{ name: 'new', description: 'New' }])

      expect(records['sess-1'].platform.skillMsgIds).toEqual([42])
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 43)
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 44)
      expect(bot.api.deleteMessage).not.toHaveBeenCalledWith(12345, 42)
    })

    it('does not issue Telegram or persistence calls for a repeated identical update', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      const commands = [{ name: 'same', description: 'Same' }]
      await manager.send('sess-1', 100, commands)
      vi.clearAllMocks()

      await manager.send('sess-1', 100, commands)

      expect(bot.api.sendMessage).not.toHaveBeenCalled()
      expect(bot.api.editMessageText).not.toHaveBeenCalled()
      expect(bot.api.pinChatMessage).not.toHaveBeenCalled()
      expect(sessionManager.patchRecord).not.toHaveBeenCalled()
    })

    it('serializes concurrent updates so only the final complete set remains current', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      commandMocks.buildSkillMessages
        .mockReturnValueOnce(['first 1', 'first 2'])
        .mockReturnValueOnce(['second 1'])

      await Promise.all([
        manager.send('sess-1', 100, [{ name: 'first', description: 'First' }]),
        manager.send('sess-1', 100, [{ name: 'second', description: 'Second' }]),
      ])

      expect(records['sess-1'].platform.skillMsgIds).toEqual([44])
      expect(records['sess-1'].platform.skillStaleMsgIds).toBeUndefined()
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 42)
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 43)
    })

    it('migrates a legacy persisted skillMsgId after verifying it by edit', async () => {
      const records = {
        'sess-1': { sessionId: 'sess-1', platform: { topicId: 100, skillMsgId: 99 } },
      }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)

      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      expect(bot.api.editMessageText).toHaveBeenCalledWith(12345, 99, expect.any(String), expect.any(Object))
      expect(bot.api.sendMessage).not.toHaveBeenCalled()
      expect(records['sess-1'].platform).toMatchObject({
        skillMsgId: 99,
        skillMsgIds: [99],
        skillMsgDigest: expect.any(String),
      })
    })

    it('recovers a new multi-ID record after restart without duplicating messages', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      const commands = [{ name: 'test', description: 'Test' }]
      commandMocks.buildSkillMessages.mockReturnValue(['part 1', 'part 2'])
      await manager.send('sess-1', 100, commands)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      vi.clearAllMocks()

      await manager.send('sess-1', 100, commands)

      expect(bot.api.editMessageText).toHaveBeenCalledTimes(2)
      expect(bot.api.sendMessage).not.toHaveBeenCalled()
      expect(bot.api.deleteMessage).not.toHaveBeenCalled()
      expect(records['sess-1'].platform.skillMsgIds).toEqual([42, 43])
    })

    it('finishes a persisted stale-ID cleanup journal on restart', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      const commands = [{ name: 'test', description: 'Test' }]
      commandMocks.buildSkillMessages.mockReturnValue(['part 1', 'part 2'])
      await manager.send('sess-1', 100, commands)
      records['sess-1'].platform.skillStaleMsgIds = [90, 91]
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      vi.clearAllMocks()

      await manager.send('sess-1', 100, commands)

      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 90)
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 91)
      expect(records['sess-1'].platform.skillStaleMsgIds).toBeUndefined()
      expect(bot.api.sendMessage).not.toHaveBeenCalled()
    })

    it('records a failed old-message retirement and completes it after restart', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      const oldCommands = [{ name: 'old', description: 'Old' }]
      const newCommands = [{ name: 'new', description: 'New' }]
      await manager.send('sess-1', 100, oldCommands)
      commandMocks.buildSkillMessages.mockReturnValue(['new 1', 'new 2'])
      bot.api.deleteMessage.mockRejectedValueOnce(new Error('temporary Telegram failure'))

      await manager.send('sess-1', 100, newCommands)

      expect(records['sess-1'].platform.skillMsgIds).toEqual([43, 44])
      expect(records['sess-1'].platform.skillStaleMsgIds).toEqual([42])

      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      vi.clearAllMocks()
      await manager.send('sess-1', 100, newCommands)

      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 42)
      expect(records['sess-1'].platform.skillStaleMsgIds).toBeUndefined()
      expect(records['sess-1'].platform.skillMsgIds).toEqual([43, 44])
      expect(bot.api.sendMessage).not.toHaveBeenCalled()
    })

    it('never deletes an unverified persisted ID when ownership proof fails', async () => {
      const records = {
        'sess-1': { sessionId: 'sess-1', platform: { topicId: 100, skillMsgId: 777 } },
      }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      bot.api.editMessageText.mockRejectedValue(new Error('message cannot be edited by this bot'))

      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      expect(bot.api.deleteMessage).not.toHaveBeenCalledWith(12345, 777)
      expect(records['sess-1'].platform.skillMsgIds).toEqual([42])
      expect(records['sess-1'].platform.skillStaleMsgIds).toEqual([777])
    })

    it('refuses an unbounded command-message set without changing the current state', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      await manager.send('sess-1', 100, [{ name: 'current', description: 'Current' }])
      commandMocks.buildSkillMessages.mockReturnValueOnce(
        Array.from({ length: 33 }, (_, index) => `part ${index + 1}`),
      )
      vi.clearAllMocks()

      await manager.send('sess-1', 100, [{ name: 'oversized', description: 'Oversized' }])

      expect(bot.api.sendMessage).not.toHaveBeenCalled()
      expect(bot.api.editMessageText).not.toHaveBeenCalled()
      expect(bot.api.deleteMessage).not.toHaveBeenCalled()
      expect(sessionManager.patchRecord).not.toHaveBeenCalled()
      expect(records['sess-1'].platform.skillMsgIds).toEqual([42])
    })
  })

  describe('cleanup()', () => {
    it('edits message to "Session ended" and unpins', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      await manager.cleanup('sess-1')

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        expect.stringContaining('Session ended'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      )
      expect(bot.api.unpinChatMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('clears persisted skillMsgId', async () => {
      sessionManager.getSessionRecord.mockReturnValue({
        sessionId: 'sess-1',
        platform: { topicId: 100, skillMsgId: 42 },
      })

      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])
      await manager.cleanup('sess-1')

      expect(sessionManager.patchRecord).toHaveBeenCalledWith('sess-1', {
        platform: expect.not.objectContaining({ skillMsgId: expect.anything() }),
      })
    })

    it('does nothing when no message exists', async () => {
      await manager.cleanup('nonexistent')

      expect(bot.api.editMessageText).not.toHaveBeenCalled()
      expect(bot.api.unpinChatMessage).not.toHaveBeenCalled()
    })

    it('handles API errors gracefully', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])
      bot.api.editMessageText.mockRejectedValueOnce(new Error('message deleted'))

      // Should not throw
      await manager.cleanup('sess-1')
    })

    it('still unpins the current message when the cleanup text is already present', async () => {
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])
      bot.api.editMessageText.mockRejectedValueOnce(new Error('message is not modified'))

      await manager.cleanup('sess-1')

      expect(bot.api.unpinChatMessage).toHaveBeenCalledWith(12345, 42)
    })

    it('cleans a complete multi-message set and removes both new and legacy persistence fields', async () => {
      const records = { 'sess-1': { sessionId: 'sess-1', platform: { topicId: 100 } } }
      sessionManager = mockSessionManager(records)
      manager = new SkillCommandManager(bot, 12345, mockSendQueue(), sessionManager)
      commandMocks.buildSkillMessages.mockReturnValueOnce(['part 1', 'part 2', 'part 3'])
      await manager.send('sess-1', 100, [{ name: 'test', description: 'Test' }])

      await manager.cleanup('sess-1')

      expect(bot.api.editMessageText).toHaveBeenCalledWith(
        12345, 42, expect.stringContaining('Session ended'), expect.any(Object),
      )
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 43)
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(12345, 44)
      expect(records['sess-1'].platform.skillMsgId).toBeUndefined()
      expect(records['sess-1'].platform.skillMsgIds).toBeUndefined()
      expect(records['sess-1'].platform.skillMsgDigest).toBeUndefined()
      expect(records['sess-1'].platform.skillStaleMsgIds).toBeUndefined()
    })
  })
})
