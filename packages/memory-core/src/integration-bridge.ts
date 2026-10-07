/**
 * integration-bridge — inversion-of-control registry
 *
 * lain-core modules need to call integration functions (send telegram, sync obsidian, etc.)
 * but cannot import from lain-integrations. lain-integrations calls setBridge() at startup
 * to inject the actual implementations.
 */

type SendFn = (to: string, body: string, options?: Record<string, unknown>) => Promise<unknown>
type EditFn = (chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => Promise<unknown>

interface IntegrationBridge {
  sendWhatsApp?: SendFn
  sendTelegram?: SendFn
  sendTelegramLongText?: (chatId: string, body: string) => Promise<{ success: boolean; messageIds: number[]; error?: string }>
  editTelegramMessage?: EditFn
  isTelegramConfigured?: () => boolean
  sendTypingIndicator?: (phone: string) => Promise<void>
  syncMemoryToObsidian?: (mem: { id: string; memory: string; project?: string; created_at?: string }) => void | Promise<void>
  deleteMemoryFromObsidian?: (id: string) => void | Promise<void>
  syncGraphNodeToObsidian?: (key: string, attrs: { type?: string; description?: string; [k: string]: unknown }) => void | Promise<void>
}

let _bridge: IntegrationBridge = {}

export function setBridge(fns: Partial<IntegrationBridge>): void {
  _bridge = { ..._bridge, ...fns }
}

export function getBridge(): Readonly<IntegrationBridge> {
  return _bridge
}
