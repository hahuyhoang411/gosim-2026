import type { Seat } from './types.js'

export type AgentRoomKind = 'research' | 'debate' | 'brainstorm' | 'coding' | 'idle' | 'general'
export type ScenarioPresetId = 'solo_research' | 'debate' | 'brainstorm' | 'search_squad'

export const ROOM_LABELS: Record<AgentRoomKind, string> = {
  research: 'Research Room',
  debate: 'Debate Room',
  brainstorm: 'Brainstorm Room',
  coding: 'Coding Room',
  idle: 'Break Room',
  general: 'Collaboration Room',
}

export const SCENARIO_LABELS: Record<ScenarioPresetId, string> = {
  solo_research: 'Solo Research',
  debate: 'Debate',
  brainstorm: 'Brainstorm',
  search_squad: 'Search Squad',
}

const ROOM_SEAT_IDS: Record<AgentRoomKind, string[]> = {
  research: ['off2-chair', 'off1-chair-a', 'off1-chair-b', 'off4-chair'],
  debate: ['conf-chair-1', 'conf-chair-2', 'conf-chair-3', 'conf-chair-4', 'conf-chair-5', 'conf-chair-6'],
  brainstorm: ['conf-chair-1', 'conf-chair-2', 'conf-chair-3', 'conf-chair-4', 'conf-chair-5', 'conf-chair-6'],
  coding: ['off3-chair-a', 'off3-chair-b', 'off4-chair'],
  idle: ['break-chair-1', 'break-chair-2'],
  general: ['main-chair-1', 'main-chair-2', 'main-chair-3', 'main-chair-4'],
}

export function seatIdsForRoom(room: AgentRoomKind): string[] {
  return ROOM_SEAT_IDS[room]
}

export function roomForSeatId(seatId: string | null | undefined): AgentRoomKind | null {
  if (!seatId) return null
  if (seatId.startsWith('conf-chair-')) return 'debate'
  if (seatId === 'off2-chair' || seatId.startsWith('off1-chair-')) return 'research'
  if (seatId.startsWith('off3-chair-') || seatId === 'off4-chair') return 'coding'
  if (seatId.startsWith('main-chair-')) return 'general'
  if (seatId.startsWith('break-chair-')) return 'idle'
  return null
}

export function chooseSeatForRoom(
  room: AgentRoomKind,
  seats: Map<string, Seat>,
  currentSeatId: string | null,
): string | null {
  const preferred = seatIdsForRoom(room)
  if (currentSeatId && preferred.includes(currentSeatId) && seats.has(currentSeatId)) {
    return currentSeatId
  }
  for (const seatId of preferred) {
    const seat = seats.get(seatId)
    if (seat && !seat.assigned) return seatId
  }
  return null
}

export function roomForToolStatus(status: string): AgentRoomKind | null {
  if (/\b(searching the web|fetching web content)\b/i.test(status)) return 'research'
  return null
}

export function roomsForScenario(
  scenario: ScenarioPresetId,
  agentIds: number[],
): Record<number, AgentRoomKind> {
  const assignments: Record<number, AgentRoomKind> = {}
  if (scenario === 'solo_research') {
    const first = agentIds[0]
    if (first !== undefined) assignments[first] = 'research'
    return assignments
  }

  const room: AgentRoomKind = scenario === 'debate'
    ? 'debate'
    : scenario === 'brainstorm'
      ? 'brainstorm'
      : 'research'
  for (const agentId of agentIds) {
    assignments[agentId] = room
  }
  return assignments
}
