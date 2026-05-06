import type { CSSProperties } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import {
  ROOM_LABELS,
  SCENARIO_LABELS,
  roomForSeatId,
  type AgentRoomKind,
  type ScenarioPresetId,
} from '../office/roomRouting.js'
import { buildBlackboardSections, type AgentTodoItem, type AgentTodoStatus } from './blackboardModel.js'

interface BlackboardPanelProps {
  officeState: OfficeState
  agents: number[]
  agentTodoLists: Record<number, AgentTodoItem[]>
  agentRooms: Record<number, AgentRoomKind>
  activeScenario: ScenarioPresetId | null
  selectedAgent: number | null
  onSelectAgent: (id: number) => void
  onApplyScenario: (scenario: ScenarioPresetId) => void
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 10,
  width: 300,
  maxHeight: 'calc(100% - 92px)',
  zIndex: 45,
  pointerEvents: 'auto',
  background: 'rgba(30, 30, 46, 0.96)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: 'var(--pixel-shadow)',
  color: 'var(--pixel-text)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const headerStyle: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '2px solid var(--pixel-border)',
  background: 'rgba(90, 140, 255, 0.13)',
}

const scenarioButtonStyle: CSSProperties = {
  padding: '3px 6px',
  border: '1px solid var(--pixel-border-light)',
  borderRadius: 0,
  background: 'rgba(255, 255, 255, 0.06)',
  color: 'var(--pixel-text)',
  cursor: 'pointer',
  fontSize: 15,
}

const scenarioButtonActiveStyle: CSSProperties = {
  ...scenarioButtonStyle,
  border: '1px solid var(--pixel-accent)',
  background: 'var(--pixel-active-bg)',
  color: 'var(--vscode-foreground)',
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

export function BlackboardPanel({
  officeState,
  agents,
  agentTodoLists,
  agentRooms,
  activeScenario,
  selectedAgent,
  onSelectAgent,
  onApplyScenario,
}: BlackboardPanelProps) {
  const sections = buildBlackboardSections(agents, agentTodoLists)
  const scenarioButtons: ScenarioPresetId[] = ['solo_research', 'debate', 'brainstorm', 'search_squad']

  return (
    <section style={panelStyle} aria-label="Research Blackboard">
      <div style={headerStyle}>
        <div style={{ fontSize: 22, color: 'var(--vscode-foreground)' }}>Research Blackboard</div>
        <div style={{ fontSize: 16, color: 'var(--pixel-text-dim)' }}>
          {activeScenario ? `${SCENARIO_LABELS[activeScenario]} scenario` : 'Kimi TODOs from SetTodoList'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 7 }}>
          {scenarioButtons.map((scenario) => (
            <button
              key={scenario}
              type="button"
              disabled={agents.length === 0}
              onClick={() => onApplyScenario(scenario)}
              style={{
                ...(activeScenario === scenario ? scenarioButtonActiveStyle : scenarioButtonStyle),
                opacity: agents.length === 0 ? 0.45 : 1,
                cursor: agents.length === 0 ? 'default' : 'pointer',
              }}
            >
              {SCENARIO_LABELS[scenario]}
            </button>
          ))}
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
