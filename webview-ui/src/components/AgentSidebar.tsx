import type { CSSProperties } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { AgentPresence, AgentTimelineEvent, ToolActivity } from '../office/types.js'
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js'
import { flattenSubagentTools, getPresenceMeta, PRESENCE_META } from '../office/presence.js'

interface AgentSidebarProps {
  officeState: OfficeState
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentPresences: Record<number, AgentPresence>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  eventLog: AgentTimelineEvent[]
  onSelectAgent: (id: number) => void
  onCloseAgent: (id: number) => void
}

const sidebarStyle: CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 10,
  bottom: 62,
  width: 330,
  zIndex: 45,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'auto',
}

const panelStyle: CSSProperties = {
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: 'var(--pixel-shadow)',
  color: 'var(--pixel-text)',
}

const sectionTitleStyle: CSSProperties = {
  fontSize: 18,
  color: 'var(--pixel-text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 0,
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function displayName(officeState: OfficeState, id: number, subagentCharacters: SubagentCharacter[]): string {
  const ch = officeState.characters.get(id)
  if (ch?.folderName) return ch.folderName
  if (ch?.isSubagent) {
    const sub = subagentCharacters.find((item) => item.id === id)
    return sub?.label || 'Subagent'
  }
  return `Agent #${id}`
}

function toolLabel(tool: ToolActivity | undefined): string {
  if (!tool) return 'None'
  if (tool.permissionWait && !tool.done) return 'Needs approval'
  return tool.status
}

function latestTool(tools: ToolActivity[]): ToolActivity | undefined {
  return [...tools].reverse().find((tool) => !tool.done) || tools[tools.length - 1]
}

function subagentPresence(
  subTools: ToolActivity[],
  hasPermissionBubble: boolean,
): AgentPresence {
  if (subTools.some((tool) => /\b(error|failed|failure|exception)\b/i.test(tool.status))) return 'error'
  if (hasPermissionBubble || subTools.some((tool) => tool.permissionWait && !tool.done)) return 'permission'
  if (subTools.some((tool) => !tool.done)) return 'active'
  return 'idle'
}

function PresencePill({ presence }: { presence: AgentPresence }) {
  const meta = getPresenceMeta(presence)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 6px',
        border: `1px solid ${meta.color}`,
        color: meta.color,
        background: 'rgba(255, 255, 255, 0.04)',
        fontSize: 18,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        className={presence === 'active' || presence === 'subagent' ? 'pixel-agents-pulse' : undefined}
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: meta.color,
          flexShrink: 0,
        }}
      />
      {meta.shortLabel}
    </span>
  )
}

function EventRow({ event }: { event: AgentTimelineEvent }) {
  const presence = event.presence
  const color = presence ? PRESENCE_META[presence].color : 'var(--pixel-text-dim)'
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '54px 1fr',
        gap: 6,
        padding: '5px 0',
        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
      }}
    >
      <span style={{ color: 'var(--pixel-text-dim)', fontSize: 16 }}>{formatTime(event.timestamp)}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: color,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 19, color: 'var(--vscode-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {event.title}
          </span>
        </div>
        {event.detail && (
          <div style={{ color: 'var(--pixel-text-dim)', fontSize: 17, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {event.detail}
          </div>
        )}
      </div>
    </div>
  )
}

export function AgentSidebar({
  officeState,
  agents,
  selectedAgent,
  agentTools,
  agentStatuses,
  agentPresences,
  subagentTools,
  subagentCharacters,
  eventLog,
  onSelectAgent,
  onCloseAgent,
}: AgentSidebarProps) {
  const selectedCh = selectedAgent === null ? null : officeState.characters.get(selectedAgent)
  const selectedParentId = selectedCh?.isSubagent ? selectedCh.parentAgentId : selectedAgent
  const selectedParentToolId = selectedCh?.isSubagent
    ? officeState.subagentMeta.get(selectedCh.id)?.parentToolId
    : null
  const selectedName = selectedAgent === null
    ? 'No agent'
    : displayName(officeState, selectedAgent, subagentCharacters)

  const parentTools = selectedParentId === null || selectedParentId === undefined ? [] : agentTools[selectedParentId] || []
  const parentSubs = selectedParentId === null || selectedParentId === undefined ? {} : subagentTools[selectedParentId] || {}
  const selectedSubTools = selectedParentToolId ? parentSubs[selectedParentToolId] || [] : []
  const selectedPresence = selectedCh?.isSubagent
    ? subagentPresence(selectedSubTools, selectedCh.bubbleType === 'permission')
    : selectedParentId === null || selectedParentId === undefined
      ? 'idle'
      : agentPresences[selectedParentId] || 'idle'
  const selectedLatestTool = selectedCh?.isSubagent ? latestTool(selectedSubTools) : latestTool(parentTools)

  const latestSubagent = selectedParentId === null || selectedParentId === undefined
    ? null
    : [...subagentCharacters].reverse().find((sub) => sub.parentAgentId === selectedParentId)
  const recentEvents = selectedParentId === null || selectedParentId === undefined
    ? eventLog.slice(0, 20)
    : eventLog.filter((event) => event.agentId === selectedParentId).slice(0, 20)

  return (
    <aside style={sidebarStyle}>
      <div style={{ ...panelStyle, padding: '8px 10px' }}>
        <div style={{ ...sectionTitleStyle, marginBottom: 6 }}>Agents</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {agents.length === 0 ? (
            <div style={{ fontSize: 20, color: 'var(--pixel-text-dim)' }}>No agents</div>
          ) : agents.map((id) => {
            const name = displayName(officeState, id, subagentCharacters)
            const presence = agentPresences[id] || 'idle'
            const isSelected = selectedParentId === id && !selectedCh?.isSubagent
            return (
              <button
                key={id}
                onClick={() => onSelectAgent(id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignItems: 'center',
                  gap: 6,
                  border: `2px solid ${isSelected ? 'var(--pixel-accent)' : 'transparent'}`,
                  background: isSelected ? 'var(--pixel-active-bg)' : 'var(--pixel-btn-bg)',
                  color: 'var(--pixel-text)',
                  padding: '5px 6px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 0,
                  minWidth: 0,
                }}
              >
                <span style={{ fontSize: 21, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                <PresencePill presence={presence} />
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ ...panelStyle, padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <div style={{ minWidth: 0 }}>
            <div style={sectionTitleStyle}>Selected</div>
            <div style={{ fontSize: 25, color: 'var(--vscode-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedName}
            </div>
          </div>
          <PresencePill presence={selectedPresence} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr', rowGap: 4, columnGap: 8, fontSize: 19 }}>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Status</span>
          <span style={{ color: getPresenceMeta(selectedPresence).color }}>{getPresenceMeta(selectedPresence).label}</span>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Tool</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toolLabel(selectedLatestTool)}</span>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Subagent</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {latestSubagent ? latestSubagent.label : 'None'}
          </span>
          <span style={{ color: 'var(--pixel-text-dim)' }}>Raw</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedParentId === null || selectedParentId === undefined ? 'None' : agentStatuses[selectedParentId] || 'normal'}
          </span>
        </div>

        {selectedParentId !== null && selectedParentId !== undefined && flattenSubagentTools(parentSubs).length > 0 && (
          <div>
            <div style={{ ...sectionTitleStyle, marginBottom: 4 }}>Subagent Tools</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 96, overflow: 'auto' }}>
              {Object.entries(parentSubs).map(([parentToolId, list]) => {
                const sub = subagentCharacters.find((item) => item.parentAgentId === selectedParentId && item.parentToolId === parentToolId)
                return (
                  <div key={parentToolId} style={{ borderLeft: '2px solid var(--pixel-status-subagent)', paddingLeft: 7 }}>
                    <div style={{ fontSize: 17, color: 'var(--pixel-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sub?.label || parentToolId}
                    </div>
                    {list.slice(-3).map((tool) => (
                      <div key={tool.toolId} style={{ fontSize: 18, opacity: tool.done ? 0.55 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tool.permissionWait && !tool.done ? 'Needs approval' : tool.status}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {selectedParentId !== null && selectedParentId !== undefined && selectedParentId > 0 && (
          <button
            onClick={() => onCloseAgent(selectedParentId)}
            style={{
              alignSelf: 'flex-start',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              background: 'var(--pixel-btn-bg)',
              color: 'var(--pixel-close-text)',
              padding: '4px 8px',
              fontSize: 20,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        )}
      </div>

      <div style={{ ...panelStyle, minHeight: 0, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 10px 4px' }}>
          <div style={sectionTitleStyle}>Recent Events</div>
        </div>
        <div style={{ padding: '0 10px 8px', overflow: 'auto', minHeight: 0 }}>
          {recentEvents.length === 0 ? (
            <div style={{ fontSize: 20, color: 'var(--pixel-text-dim)', paddingTop: 4 }}>No events</div>
          ) : recentEvents.map((event) => (
            <EventRow key={event.eventId} event={event} />
          ))}
        </div>
      </div>
    </aside>
  )
}
