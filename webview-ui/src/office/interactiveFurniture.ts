import { getCatalogEntry } from './layout/furnitureCatalog.js'
import { ROOM_ANCHORS, type AgentRoomKind } from './roomRouting.js'
import { FurnitureType, type OfficeLayout, type PlacedFurniture } from './types.js'

const DEFAULT_BLACKBOARD_ROOMS: Record<string, AgentRoomKind> = {
  'conf-wb': 'debate',
  'off2-wb': 'research',
  'off4-wb': 'coding',
  'main-wb': 'general',
}

export function isBlackboardFurniture(item: PlacedFurniture): boolean {
  return item.type === FurnitureType.BLACKBOARD
}

export function roomForBlackboardFurniture(item: PlacedFurniture): AgentRoomKind | null {
  if (!isBlackboardFurniture(item)) return null
  const defaultRoom = DEFAULT_BLACKBOARD_ROOMS[item.uid]
  if (defaultRoom) return defaultRoom

  let nearestRoom: AgentRoomKind | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const [room, anchor] of Object.entries(ROOM_ANCHORS) as [AgentRoomKind, { col: number; row: number }][]) {
    const colDelta = item.col - anchor.col
    const rowDelta = item.row - anchor.row
    const distance = colDelta * colDelta + rowDelta * rowDelta
    if (distance < nearestDistance) {
      nearestRoom = room
      nearestDistance = distance
    }
  }
  return nearestRoom
}

export function findInteractiveFurnitureAtTile(
  layout: OfficeLayout,
  col: number,
  row: number,
): PlacedFurniture | null {
  for (let i = layout.furniture.length - 1; i >= 0; i--) {
    const item = layout.furniture[i]
    if (!isBlackboardFurniture(item)) continue
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const hit = col >= item.col
      && col < item.col + entry.footprintW
      && row >= item.row
      && row < item.row + entry.footprintH
    if (hit) return item
  }
  return null
}
