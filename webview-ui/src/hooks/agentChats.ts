import type { AgentChatEntry } from './useExtensionMessages.js'

const coalescibleWireRoles = new Set<AgentChatEntry['role']>(['assistant', 'thinking'])

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

function firstCoalescedId(id: string): string {
  return id.split('..', 1)[0] || id
}

function canCoalesceWireEntry(previous: AgentChatEntry | undefined, next: AgentChatEntry): previous is AgentChatEntry {
  return !!previous
    && previous.agentId === next.agentId
    && previous.source === 'wire'
    && next.source === 'wire'
    && previous.role === next.role
    && coalescibleWireRoles.has(next.role)
}

export function coalesceVisibleAgentChatEntries(entries: AgentChatEntry[]): AgentChatEntry[] {
  const visible: AgentChatEntry[] = []
  for (const entry of entries) {
    const previous = visible[visible.length - 1]
    if (!canCoalesceWireEntry(previous, entry)) {
      visible.push(entry)
      continue
    }

    visible[visible.length - 1] = {
      ...previous,
      id: `${firstCoalescedId(previous.id)}..${entry.id}`,
      text: `${previous.text}${entry.text}`,
    }
  }
  return visible
}
