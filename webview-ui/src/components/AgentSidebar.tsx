import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { AgentPresence, AgentTimelineEvent, ToolActivity } from '../office/types.js'
import type {
  AgentChatEntry,
  AgentProcessInfo,
  AgentRequestMessage,
  AgentTurnState,
  SubagentCharacter,
} from '../hooks/useExtensionMessages.js'
import { flattenSubagentTools, getPresenceMeta, PRESENCE_META } from '../office/presence.js'
import {
  buildQuestionAnswers,
  hasAnswerForEveryQuestion,
  normalizeQuestionItems,
  toggleMultiSelectAnswer,
  type QuestionDraftValue,
} from './agentRequestModel.js'
import { coalesceVisibleAgentChatEntries } from '../hooks/agentChats.js'

interface AgentSidebarProps {
  officeState: OfficeState
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentPresences: Record<number, AgentPresence>
  agentChats: Record<number, AgentChatEntry[]>
  agentTurnStates: Record<number, AgentTurnState>
  agentProcessStates: Record<number, AgentProcessInfo>
  agentRequests: Record<number, AgentRequestMessage[]>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  eventLog: AgentTimelineEvent[]
  onSelectAgent: (id: number) => void
  onCloseAgent: (id: number) => void
  onSendAgentMessage: (agentId: number, text: string) => void
  onCancelAgentTurn: (agentId: number) => void
  onRespondApproval: (agentId: number, requestId: string, response: 'approve' | 'approve_for_session' | 'reject', feedback?: string) => void
  onRespondQuestion: (agentId: number, requestId: string, answers: Record<string, string>) => void
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

function payloadText(payload: Record<string, unknown>, fallback: string): string {
  const description = payload.description
  const action = payload.action
  if (typeof description === 'string' && description.trim()) return description
  if (typeof action === 'string' && action.trim()) return action
  return fallback
}

function displayBlockText(block: unknown): string | null {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  const record = block as Record<string, unknown>
  if (record.type === 'brief' && typeof record.text === 'string') return record.text
  if (record.type === 'shell' && typeof record.command === 'string') return `$ ${record.command}`
  if (record.type === 'diff' && typeof record.path === 'string') return `Diff: ${record.path}`
  if (record.type === 'todo' && Array.isArray(record.items)) return `${record.items.length} todo item(s)`
  return null
}

function DisplayBlocks({ payload }: { payload: Record<string, unknown> }) {
  const blocks = Array.isArray(payload.display)
    ? payload.display.map(displayBlockText).filter((text): text is string => Boolean(text))
    : []
  if (blocks.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
      {blocks.map((block, index) => (
        <div
          key={`${index}:${block}`}
          style={{
            fontSize: 16,
            color: 'var(--pixel-text-dim)',
            borderLeft: '2px solid var(--pixel-border)',
            paddingLeft: 6,
            overflowWrap: 'anywhere',
          }}
        >
          {block}
        </div>
      ))}
    </div>
  )
}

function ApprovalRequestCard({
  agentId,
  request,
  onRespondApproval,
}: {
  agentId: number
  request: AgentRequestMessage
  onRespondApproval: AgentSidebarProps['onRespondApproval']
}) {
  const [feedback, setFeedback] = useState('')
  const payload = request.payload || {}
  const description = payloadText(payload, request.requestType)
  const sender = typeof payload.sender === 'string' && payload.sender.trim() ? payload.sender : 'Kimi'
  const submit = (response: 'approve' | 'approve_for_session' | 'reject') => {
    onRespondApproval(agentId, request.requestId, response, feedback.trim() || undefined)
  }

  return (
    <div style={{ border: '2px solid var(--pixel-status-permission)', padding: 6, background: 'rgba(204, 167, 0, 0.12)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <div style={{ fontSize: 18, color: 'var(--pixel-status-permission)' }}>Approval needed</div>
        <div style={{ fontSize: 16, color: 'var(--pixel-text-dim)' }}>{sender}</div>
      </div>
      <div style={{ fontSize: 18, color: 'var(--vscode-foreground)', marginBottom: 5 }}>{description}</div>
      <DisplayBlocks payload={payload} />
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Optional feedback for Kimi, especially when rejecting…"
        rows={2}
        style={requestTextareaStyle}
      />
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button style={miniButtonStyle} onClick={() => submit('approve')}>Approve once</button>
        <button style={miniButtonStyle} onClick={() => submit('approve_for_session')}>Session</button>
        <button style={{ ...miniButtonStyle, color: 'var(--pixel-status-error)' }} onClick={() => submit('reject')}>Reject</button>
      </div>
    </div>
  )
}

function QuestionRequestCard({
  agentId,
  request,
  onRespondQuestion,
}: {
  agentId: number
  request: AgentRequestMessage
  onRespondQuestion: AgentSidebarProps['onRespondQuestion']
}) {
  const questions = normalizeQuestionItems(request.payload || {})
  const [draft, setDraft] = useState<Record<string, QuestionDraftValue>>({})
  const canSubmit = hasAnswerForEveryQuestion(questions, draft)

  const setAnswer = (question: string, value: QuestionDraftValue) => {
    setDraft((prev) => ({ ...prev, [question]: value }))
  }

  return (
    <div style={{ border: '2px solid var(--pixel-status-waiting)', padding: 6, background: 'rgba(209, 134, 22, 0.12)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginBottom: 5 }}>
        <div style={{ fontSize: 18, color: 'var(--pixel-status-waiting)' }}>Question</div>
        <div style={{ fontSize: 16, color: 'var(--pixel-text-dim)' }}>{questions.length} item{questions.length === 1 ? '' : 's'}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {questions.map((question, index) => {
          const value = draft[question.question]
          const selectedSet = new Set(Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
          return (
            <div key={question.question} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--pixel-text-dim)', fontSize: 15 }}>{index + 1}/{questions.length}</span>
                {question.header && (
                  <span style={{ color: 'var(--pixel-status-waiting)', fontSize: 15, border: '1px solid currentColor', padding: '0 4px' }}>
                    {question.header}
                  </span>
                )}
                {question.multiSelect && <span style={{ color: 'var(--pixel-text-dim)', fontSize: 15 }}>multi-select</span>}
              </div>
              <div style={{ fontSize: 19, color: 'var(--vscode-foreground)' }}>{question.question}</div>
              {question.options.length === 0 ? (
                <textarea
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => setAnswer(question.question, e.target.value)}
                  placeholder="Type your answer…"
                  rows={2}
                  style={requestTextareaStyle}
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {question.options.map((option) => {
                    const selected = selectedSet.has(option.label)
                    return (
                      <button
                        key={option.label}
                        onClick={() => {
                          if (question.multiSelect) {
                            setDraft((prev) => ({
                              ...prev,
                              [question.question]: toggleMultiSelectAnswer(
                                question,
                                Array.isArray(prev[question.question]) ? prev[question.question] as string[] : [],
                                option.label,
                              ),
                            }))
                          } else {
                            setAnswer(question.question, option.label)
                          }
                        }}
                        style={{
                          ...miniButtonStyle,
                          textAlign: 'left',
                          borderColor: selected ? 'var(--pixel-status-waiting)' : 'var(--pixel-border)',
                          background: selected ? 'rgba(209, 134, 22, 0.22)' : miniButtonStyle.background,
                        }}
                      >
                        {option.label}
                        {option.description && <span style={{ display: 'block', color: 'var(--pixel-text-dim)', fontSize: 15 }}>{option.description}</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 7 }}>
        <button style={miniButtonStyle} onClick={() => onRespondQuestion(agentId, request.requestId, {})}>Skip</button>
        <button
          style={{ ...miniButtonStyle, opacity: canSubmit ? 1 : 0.45, cursor: canSubmit ? 'pointer' : 'default' }}
          disabled={!canSubmit}
          onClick={() => onRespondQuestion(agentId, request.requestId, buildQuestionAnswers(questions, draft))}
        >
          Submit
        </button>
      </div>
    </div>
  )
}

function RequestCard({
  agentId,
  request,
  onRespondApproval,
  onRespondQuestion,
}: {
  agentId: number
  request: AgentRequestMessage
  onRespondApproval: AgentSidebarProps['onRespondApproval']
  onRespondQuestion: AgentSidebarProps['onRespondQuestion']
}) {
  if (request.requestType === 'QuestionRequest') {
    return <QuestionRequestCard agentId={agentId} request={request} onRespondQuestion={onRespondQuestion} />
  }
  return <ApprovalRequestCard agentId={agentId} request={request} onRespondApproval={onRespondApproval} />
}

const miniButtonStyle: CSSProperties = {
  background: 'var(--pixel-btn-bg)',
  color: 'var(--pixel-text)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '3px 6px',
  fontSize: 17,
  cursor: 'pointer',
}

const requestTextareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'var(--pixel-text)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  fontSize: 17,
  outline: 'none',
  marginBottom: 5,
}

function ChatPanel({
  agentId,
  messages,
  requests,
  turnState,
  process,
  onSendAgentMessage,
  onCancelAgentTurn,
  onRespondApproval,
  onRespondQuestion,
}: {
  agentId: number | null | undefined
  messages: AgentChatEntry[]
  requests: AgentRequestMessage[]
  turnState: AgentTurnState | undefined
  process: AgentProcessInfo | undefined
  onSendAgentMessage: AgentSidebarProps['onSendAgentMessage']
  onCancelAgentTurn: AgentSidebarProps['onCancelAgentTurn']
  onRespondApproval: AgentSidebarProps['onRespondApproval']
  onRespondQuestion: AgentSidebarProps['onRespondQuestion']
}) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const isDirectChatAgent = process?.state === 'ready'
  const canSend = agentId !== null
    && agentId !== undefined
    && draft.trim().length > 0
    && isDirectChatAgent
  const running = turnState === 'running' || turnState === 'waiting_for_approval' || turnState === 'waiting_for_answer'
  const visibleMessages = coalesceVisibleAgentChatEntries(messages)
  const lastMessage = visibleMessages[visibleMessages.length - 1]

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [visibleMessages.length, lastMessage?.id, lastMessage?.text, requests.length, agentId])

  const send = () => {
    if (!canSend || agentId === null || agentId === undefined) return
    onSendAgentMessage(agentId, draft)
    setDraft('')
  }

  const stateLabel = !process
    ? 'External'
    : process.state === 'starting'
      ? 'Starting'
      : process.state === 'crashed'
      ? 'Crashed'
      : process.state === 'exited'
        ? 'Exited'
        : turnState === 'waiting_for_approval'
          ? 'Approval'
          : turnState === 'waiting_for_answer'
            ? 'Question'
            : turnState === 'running'
              ? 'Running'
              : 'Ready'

  return (
    <div style={{ ...panelStyle, minHeight: 215, maxHeight: 320, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={sectionTitleStyle}>Chat</div>
        <span style={{ color: process?.state === 'crashed' ? 'var(--pixel-status-error)' : running ? 'var(--pixel-status-active)' : 'var(--pixel-text-dim)', fontSize: 17 }}>
          {stateLabel}
        </span>
      </div>

      <div ref={listRef} style={{ padding: '0 10px 6px', overflow: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {messages.length === 0 && requests.length === 0 ? (
          <div style={{ fontSize: 19, color: 'var(--pixel-text-dim)' }}>
            {agentId === null || agentId === undefined ? 'Select an agent to chat.' : 'No chat yet.'}
          </div>
        ) : visibleMessages.map((message) => (
          <div
            key={message.id}
            style={{
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '92%',
              background: message.role === 'user'
                ? 'rgba(90, 140, 255, 0.18)'
                : message.role === 'assistant'
                  ? 'rgba(90, 200, 140, 0.16)'
                  : message.role === 'thinking'
                    ? 'rgba(180, 140, 255, 0.12)'
                    : 'rgba(255, 255, 255, 0.08)',
              border: `1px solid ${message.role === 'user'
                ? 'rgba(90, 140, 255, 0.55)'
                : message.role === 'assistant'
                  ? 'rgba(90, 200, 140, 0.55)'
                  : 'rgba(255, 255, 255, 0.16)'}`,
              padding: '4px 6px',
              fontSize: 18,
              color: 'var(--vscode-foreground)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            <div style={{ color: 'var(--pixel-text-dim)', fontSize: 14, marginBottom: 1 }}>
              {message.role === 'thinking' ? 'thinking' : message.source === 'steer' ? 'steer' : message.role}
            </div>
            {message.text}
          </div>
        ))}

        {agentId !== null && agentId !== undefined && requests.map((request) => (
          <RequestCard
            key={request.requestId}
            agentId={agentId}
            request={request}
            onRespondApproval={onRespondApproval}
            onRespondQuestion={onRespondQuestion}
          />
        ))}
      </div>

      <div style={{ padding: '6px 10px 9px', display: 'grid', gridTemplateColumns: running ? '1fr auto auto' : '1fr auto', gap: 5 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={!process ? 'Open a New Kimi Agent for direct chat…' : running ? 'Steer the running turn…' : 'Message Kimi…'}
          disabled={!isDirectChatAgent}
          rows={2}
          style={{
            minWidth: 0,
            resize: 'none',
            background: 'rgba(255, 255, 255, 0.08)',
            color: 'var(--pixel-text)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            padding: '4px 6px',
            fontSize: 18,
            outline: 'none',
          }}
        />
        {running && agentId !== null && agentId !== undefined && (
          <button style={{ ...miniButtonStyle, color: 'var(--pixel-status-error)' }} onClick={() => onCancelAgentTurn(agentId)}>
            Cancel
          </button>
        )}
        <button
          style={{ ...miniButtonStyle, opacity: canSend ? 1 : 0.45, cursor: canSend ? 'pointer' : 'default' }}
          onClick={send}
          disabled={!canSend}
        >
          {running ? 'Steer' : 'Send'}
        </button>
      </div>
    </div>
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
  agentChats,
  agentTurnStates,
  agentProcessStates,
  agentRequests,
  subagentTools,
  subagentCharacters,
  eventLog,
  onSelectAgent,
  onCloseAgent,
  onSendAgentMessage,
  onCancelAgentTurn,
  onRespondApproval,
  onRespondQuestion,
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
  const selectedChat = selectedParentId === null || selectedParentId === undefined ? [] : agentChats[selectedParentId] || []
  const selectedRequests = selectedParentId === null || selectedParentId === undefined ? [] : agentRequests[selectedParentId] || []
  const selectedTurnState = selectedParentId === null || selectedParentId === undefined ? undefined : agentTurnStates[selectedParentId]
  const selectedProcess = selectedParentId === null || selectedParentId === undefined ? undefined : agentProcessStates[selectedParentId]

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

      <ChatPanel
        agentId={selectedParentId}
        messages={selectedChat}
        requests={selectedRequests}
        turnState={selectedTurnState}
        process={selectedProcess}
        onSendAgentMessage={onSendAgentMessage}
        onCancelAgentTurn={onCancelAgentTurn}
        onRespondApproval={onRespondApproval}
        onRespondQuestion={onRespondQuestion}
      />

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
