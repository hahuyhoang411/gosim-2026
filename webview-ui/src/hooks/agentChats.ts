import type { AgentChatEntry } from './useExtensionMessages.js'

export function upsertAgentChatEntry(
  entries: AgentChatEntry[],
  entry: AgentChatEntry,
): AgentChatEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index === -1) return [...entries, entry]

  const next = [...entries]
  next[index] = entry
  return next
}
