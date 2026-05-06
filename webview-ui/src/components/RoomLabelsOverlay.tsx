import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { ROOM_LABELS, type AgentRoomKind } from '../office/roomRouting.js'
import { worldTileToScreen } from './worldOverlayPosition.js'

interface RoomLabelAnchor {
  room: AgentRoomKind
  col: number
  row: number
}

interface RoomLabelsOverlayProps {
  officeState: OfficeState
  containerRef: RefObject<HTMLDivElement | null>
  zoom: number
  panRef: RefObject<{ x: number; y: number }>
}

const roomLabelAnchors: RoomLabelAnchor[] = [
  { room: 'debate', col: 5.8, row: 0.4 },
  { room: 'research', col: 3.4, row: 14.1 },
  { room: 'coding', col: 3.4, row: 22.1 },
  { room: 'brainstorm', col: 11.6, row: 8.2 },
  { room: 'idle', col: 16.1, row: 19.1 },
]

const labelStyle: CSSProperties = {
  position: 'absolute',
  transform: 'translate(-50%, -50%)',
  zIndex: 26,
  pointerEvents: 'none',
  padding: '2px 10px 3px',
  borderRadius: 999,
  background: 'rgba(255, 255, 255, 0.84)',
  color: 'rgba(38, 36, 46, 0.72)',
  fontSize: 18,
  lineHeight: 1,
  boxShadow: '0 1px 0 rgba(0, 0, 0, 0.16)',
  whiteSpace: 'nowrap',
}

export function RoomLabelsOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: RoomLabelsOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <>
      {roomLabelAnchors.map(({ room, col, row }) => {
        const position = worldTileToScreen(officeState, containerRef, zoom, panRef, col, row)
        if (!position) return null
        return (
          <div key={room} style={{ ...labelStyle, left: position.x, top: position.y }}>
            {ROOM_LABELS[room]}
          </div>
        )
      })}
    </>
  )
}
