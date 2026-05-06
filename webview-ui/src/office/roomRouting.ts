import type { Seat } from './types.js'

export type AgentRoomKind = 'research' | 'debate' | 'brainstorm' | 'coding' | 'idle' | 'general'

export const ROOM_LABELS: Record<AgentRoomKind, string> = {
  research: 'Research Room',
  debate: 'PI Room',
  brainstorm: 'Meeting Room',
  coding: 'Coding Room',
  idle: 'Break Room',
  general: 'Collaboration Room',
}

export interface RoomAnchor {
  col: number
  row: number
}

export const ROOM_ANCHORS: Record<AgentRoomKind, RoomAnchor> = {
  debate: { col: 5.7, row: 1.2 },
  brainstorm: { col: 12.1, row: 9.5 },
  research: { col: 3.8, row: 15.4 },
  coding: { col: 3.9, row: 23.4 },
  general: { col: 14.3, row: 9.3 },
  idle: { col: 16.4, row: 22.6 },
}

const ROOM_SEAT_IDS: Record<AgentRoomKind, string[]> = {
  research: ['off2-chair', 'off1-chair-a', 'off1-chair-b', 'off4-chair'],
  debate: ['conf-chair-1', 'conf-chair-2', 'conf-chair-3', 'conf-chair-4', 'conf-chair-5', 'conf-chair-6'],
  brainstorm: ['main-chair-1', 'main-chair-2', 'main-chair-3', 'main-chair-4'],
  coding: ['off3-chair-a', 'off3-chair-b', 'off4-chair'],
  idle: ['break-chair-1', 'break-chair-2'],
  general: [],
}

export function seatIdsForRoom(room: AgentRoomKind): string[] {
  return ROOM_SEAT_IDS[room]
}

export function roomForSeatId(seatId: string | null | undefined): AgentRoomKind | null {
  if (!seatId) return null
  if (seatId.startsWith('conf-chair-')) return 'debate'
  if (seatId === 'off2-chair' || seatId.startsWith('off1-chair-')) return 'research'
  if (seatId.startsWith('off3-chair-') || seatId === 'off4-chair') return 'coding'
  if (seatId.startsWith('main-chair-')) return 'brainstorm'
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
  if (/\b(searching the web|searching web|websearch|fetching web content|webfetch)\b/i.test(status)) return 'research'
  if (/^(subtask:|running subtask|task:)/i.test(status)) return 'brainstorm'
  if (/^(reading|editing|writing|running|searching files|searching code)\b/i.test(status)) return 'coding'
  return null
}

export function reportRoomForSubagent(): AgentRoomKind {
  return 'debate'
}
