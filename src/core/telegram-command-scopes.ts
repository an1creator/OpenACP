export const TELEGRAM_COMMAND_LOCALES = ['', 'en', 'ru'] as const
export type TelegramCommandLocale = typeof TELEGRAM_COMMAND_LOCALES[number]

export interface TelegramScopedCommand {
  command: string
  description: string
}

/** Apply Telegram's documented group/supergroup precedence for one locale. */
export function effectiveTelegramGroupCommands(
  lists: {
    default: readonly TelegramScopedCommand[]
    allGroup: readonly TelegramScopedCommand[]
    allAdmins: readonly TelegramScopedCommand[]
    chat: readonly TelegramScopedCommand[]
    chatAdmins: readonly TelegramScopedCommand[]
  },
  administrator: boolean,
): readonly TelegramScopedCommand[] {
  const candidates = administrator
    ? [lists.chatAdmins, lists.chat, lists.allAdmins, lists.allGroup, lists.default]
    : [lists.chat, lists.allGroup, lists.default]
  return candidates.find((commands) => commands.length > 0) ?? []
}
