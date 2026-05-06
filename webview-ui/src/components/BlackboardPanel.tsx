import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import {
  ROOM_ANCHORS,
  ROOM_LABELS,
  roomForSeatId,
  type AgentRoomKind,
} from '../office/roomRouting.js'
import { buildBlackboardSections, type AgentTodoItem, type AgentTodoStatus } from './blackboardModel.js'
import { worldTileToScreen } from './worldOverlayPosition.js'

interface BlackboardPanelProps {
  officeState: OfficeState
  agents: number[]
  agentTodoLists: Record<number, AgentTodoItem[]>
  agentRooms: Record<number, AgentRoomKind>
  selectedAgent: number | null
  containerRef: RefObject<HTMLDivElement | null>
  zoom: number
  panRef: RefObject<{ x: number; y: number }>
  onSelectAgent: (id: number) => void
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  width: 286,
  maxHeight: 286,
  zIndex: 38,
  transform: 'translate(-50%, -50%)',
  pointerEvents: 'auto',
  background: '#17362c',
  border: '4px solid #8d6a24',
  borderRadius: 0,
  boxShadow: '0 0 0 2px #3f2a10, 4px 4px 0 #0a0a14',
  color: 'var(--pixel-text)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const headerStyle: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '3px solid #8d6a24',
  background: 'rgba(14, 25, 23, 0.34)',
}

const statusMeta: Record<AgentTodoStatus, { symbol: string; color: string; label: string }> = {
  done: { symbol: '✓', color: 'var(--pixel-green)', label: 'Done' },
  in_progress: { symbol: '→', color: 'var(--vscode-charts-blue)', label: 'Doing' },
  pending: { symbol: '○', color: 'var(--pixel-text-dim)', label: 'Todo' },
}

function agentDisplayName(officeState: OfficeState, id: number): string {
  return officeState.characters.get(id)?.folderName || `Agent #${id}`
}

function agentRoomLabel(officeState: OfficeState, agentRooms: Record<number, AgentRoomKind>, id: number): string {
  const assignedRoom = agentRooms[id]
  if (assignedRoom) return ROOM_LABELS[assignedRoom]
  const seatRoom = roomForSeatId(officeState.characters.get(id)?.seatId)
  return seatRoom ? ROOM_LABELS[seatRoom] : 'Unassigned'
}

function boardRoomForSelection(
  officeState: OfficeState,
  agentRooms: Record<number, AgentRoomKind>,
  selectedAgent: number | null,
  agents: number[],
): AgentRoomKind {
  const candidates = [
    ...(selectedAgent !== null ? [selectedAgent] : []),
    ...agents,
  ]

  for (const id of candidates) {
    const assignedRoom = agentRooms[id]
    if (assignedRoom) return assignedRoom
    const seatRoom = roomForSeatId(officeState.characters.get(id)?.seatId)
    if (seatRoom) return seatRoom
  }

  return 'debate'
}

export function BlackboardPanel({
  officeState,
  agents,
  agentTodoLists,
  agentRooms,
  selectedAgent,
  containerRef,
  zoom,
  panRef,
  onSelectAgent,
}: BlackboardPanelProps) {
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

  const sections = buildBlackboardSections(agents, agentTodoLists)
  const boardRoom = boardRoomForSelection(officeState, agentRooms, selectedAgent, agents)
  const anchor = ROOM_ANCHORS[boardRoom]
  const position = worldTileToScreen(officeState, containerRef, zoom, panRef, anchor.col, anchor.row)

  if (!position) return null

  return (
    <section style={{ ...panelStyle, left: position.x, top: position.y }} aria-label={`${ROOM_LABELS[boardRoom]} Blackboard`}>
      <div style={headerStyle}>
        <div style={{ fontSize: 21, color: 'var(--vscode-foreground)' }}>{ROOM_LABELS[boardRoom]} Blackboard</div>
        <div style={{ fontSize: 16, color: 'var(--pixel-text-dim)' }}>
          Live Kimi TODOs · room follows tool/action state
        </div>
      </div>

      <div style={{ padding: 8, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {agents.length > 0 && (
          <div style={{ border: '1px solid var(--pixel-border)', padding: 6, background: 'rgba(255, 255, 255, 0.035)' }}>
            <div style={{ fontSize: 16, color: 'var(--pixel-text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>
              Rooms
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {agents.map((agentId) => (
                <button
                  key={agentId}
                  type="button"
                  onClick={() => onSelectAgent(agentId)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 6,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: selectedAgent === agentId ? 'var(--vscode-foreground)' : 'var(--pixel-text)',
                    cursor: 'pointer',
                    fontSize: 16,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {agentDisplayName(officeState, agentId)}
                  </span>
                  <span style={{ color: 'var(--pixel-text-dim)', whiteSpace: 'nowrap' }}>
                    {agentRoomLabel(officeState, agentRooms, agentId)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {sections.length === 0 ? (
          <div style={{ fontSize: 18, color: 'var(--pixel-text-dim)', lineHeight: 1.25 }}>
            Waiting for SetTodoList…
          </div>
        ) : (
          sections.map((section) => {
            const selected = selectedAgent === section.agentId
            return (
              <button
                key={section.agentId}
                type="button"
                onClick={() => onSelectAgent(section.agentId)}
                style={{
                  textAlign: 'left',
                  padding: 7,
                  border: `2px solid ${selected ? 'var(--pixel-accent)' : 'var(--pixel-border)'}`,
                  background: selected ? 'var(--pixel-active-bg)' : 'rgba(255, 255, 255, 0.04)',
                  color: 'var(--pixel-text)',
                  cursor: 'pointer',
                  boxShadow: selected ? '1px 1px 0 #0a0a14' : 'none',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 19, color: 'var(--vscode-foreground)' }}>
                    {agentDisplayName(officeState, section.agentId)}
                  </span>
                  <span style={{ fontSize: 16, color: 'var(--pixel-text-dim)', whiteSpace: 'nowrap' }}>
                    {section.summary.done}/{section.summary.total}
                  </span>
                </div>
                <div style={{ fontSize: 15, color: 'var(--pixel-text-dim)', marginBottom: 5 }}>
                  {agentRoomLabel(officeState, agentRooms, section.agentId)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {section.todos.map((todo, index) => {
                    const meta = statusMeta[todo.status]
                    return (
                      <div
                        key={`${section.agentId}:${index}:${todo.title}`}
                        style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 5, alignItems: 'start' }}
                      >
                        <span title={meta.label} style={{ color: meta.color, fontSize: 18, lineHeight: 1 }}>
                          {meta.symbol}
                        </span>
                        <span
                          style={{
                            fontSize: 17,
                            lineHeight: 1.15,
                            color: todo.status === 'done' ? 'var(--pixel-text-dim)' : 'var(--vscode-foreground)',
                            textDecoration: todo.status === 'done' ? 'line-through' : 'none',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {todo.title}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </button>
            )
          })
        )}
      </div>
    </section>
  )
}
