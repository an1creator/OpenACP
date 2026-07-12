export type TelegramReturnTarget = 'settings'

export interface TelegramCommandCallback {
  command: string
  returnTarget?: TelegramReturnTarget
}

const SETTINGS_PREFIX = 'c/@settings:'

/** Encode an allow-listed return context when it fits Telegram's callback limit. */
export function contextualCommandCallback(
  command: string,
  target: TelegramReturnTarget,
): string | undefined {
  if (!command.startsWith('/')) throw new Error('Telegram navigation commands must start with /')
  const data = target === 'settings' ? `${SETTINGS_PREFIX}${command}` : undefined
  return data && Buffer.byteLength(data, 'utf8') <= 64 ? data : undefined
}

/** Encode a Settings entry; fixed entry commands must fit without ephemeral cache state. */
export function settingsCommandCallback(command: string): string {
  const data = contextualCommandCallback(command, 'settings')
  if (!data) throw new Error('Telegram navigation callback exceeds 64 bytes')
  return data
}

/** Decode only allow-listed return destinations; unknown envelopes stay ordinary commands. */
export function decodeCommandCallback(data: string): TelegramCommandCallback {
  if (data.startsWith(SETTINGS_PREFIX)) {
    return { command: data.slice(SETTINGS_PREFIX.length), returnTarget: 'settings' }
  }
  return { command: data.slice(2) }
}

export function returnButton(target: TelegramReturnTarget): { text: string; callback_data: string } {
  switch (target) {
    case 'settings':
      return { text: '◀️ Back to Settings', callback_data: 's:back:refresh' }
  }
}
