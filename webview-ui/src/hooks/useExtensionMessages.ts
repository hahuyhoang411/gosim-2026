import { useState, useEffect, useMemo, useRef } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { AgentPresence, AgentTimelineEvent, AgentTimelineEventType, OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { deriveAgentPresence } from '../office/presence.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'
import { upsertAgentChatEntry } from './agentChats.js'
import { normalizeAgentTodos, summarizeTodos, type AgentTodoItem } from '../components/blackboardModel.js'
import {
  ROOM_LABELS,
  reportRoomForSubagent,
  roomForSeatId,
  roomForToolStatus,
  type AgentRoomKind,
} from '../office/roomRouting.js'

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface KimiSessionSummary {
  sessionId: string
  workdirHash: string
  workdirPath?: string
  title: string
  updatedAt: number
  active: boolean
}

export type AgentChatRole = 'user' | 'assistant' | 'thinking' | 'system' | 'tool'
export type AgentTurnState = 'idle' | 'running' | 'waiting_for_approval' | 'waiting_for_answer' | 'cancelled' | 'error'
export type AgentProcessState = 'starting' | 'ready' | 'exited' | 'crashed'
export type AgentBubbleKind = 'user' | 'assistant' | 'system' | 'steer' | 'error'

export interface AgentChatEntry {
  id: string
  agentId: number
  role: AgentChatRole
  text: string
  createdAt: number
  source?: 'prompt' | 'steer' | 'wire' | 'system' | 'request'
  turnId?: string
}

export interface AgentRequestMessage {
  requestId: string
  requestType: string
  payload: Record<string, unknown>
}

export interface AgentProcessInfo {
  state: AgentProcessState
  pid?: number
  error?: string
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  agentPresences: Record<number, AgentPresence>
  agentChats: Record<number, AgentChatEntry[]>
  agentTurnStates: Record<number, AgentTurnState>
  agentProcessStates: Record<number, AgentProcessInfo>
  agentRequests: Record<number, AgentRequestMessage[]>
  agentTodoLists: Record<number, AgentTodoItem[]>
  agentRooms: Record<number, AgentRoomKind>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  eventLog: AgentTimelineEvent[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
  kimiSessions: KimiSessionSummary[]
  setSelectedAgent: (id: number | null) => void
  setAgentRooms: (rooms: Record<number, AgentRoomKind>) => void
}

const MAX_TIMELINE_EVENTS = 200

function compactText(text: string | undefined, maxLen = 120): string | undefined {
  if (!text) return undefined
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLen) return normalized
  return `${normalized.slice(0, maxLen - 3)}...`
}

function hasActiveTool(list: ToolActivity[] | undefined): boolean {
  return !!list?.some((tool) => !tool.done)
}

function routeCharacterToRoom(os: OfficeState, id: number, room: AgentRoomKind): boolean {
  const currentRoom = roomForSeatId(os.characters.get(id)?.seatId)
  if (currentRoom === room) {
    os.moveAgentToRoom(id, room)
    return false
  }
  return os.moveAgentToRoom(id, room)
}

export function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [agentChats, setAgentChats] = useState<Record<number, AgentChatEntry[]>>({})
  const [agentTurnStates, setAgentTurnStates] = useState<Record<number, AgentTurnState>>({})
  const [agentProcessStates, setAgentProcessStates] = useState<Record<number, AgentProcessInfo>>({})
  const [agentRequests, setAgentRequests] = useState<Record<number, AgentRequestMessage[]>>({})
  const [agentTodoLists, setAgentTodoLists] = useState<Record<number, AgentTodoItem[]>>({})
  const [agentRooms, setAgentRooms] = useState<Record<number, AgentRoomKind>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [eventLog, setEventLog] = useState<AgentTimelineEvent[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [kimiSessions, setKimiSessions] = useState<KimiSessionSummary[]>([])

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)
  const eventSeqRef = useRef(0)
  const agentToolsRef = useRef(agentTools)
  const agentStatusesRef = useRef(agentStatuses)
  const agentChatsRef = useRef(agentChats)
  const subagentToolsRef = useRef(subagentTools)

  useEffect(() => {
    agentToolsRef.current = agentTools
  }, [agentTools])

  useEffect(() => {
    agentStatusesRef.current = agentStatuses
  }, [agentStatuses])

  useEffect(() => {
    agentChatsRef.current = agentChats
  }, [agentChats])

  useEffect(() => {
    subagentToolsRef.current = subagentTools
  }, [subagentTools])

  const agentPresences = useMemo(() => {
    const next: Record<number, AgentPresence> = {}
    for (const id of agents) {
      next[id] = deriveAgentPresence(id, agentTools, agentStatuses, subagentTools)
    }
    return next
  }, [agents, agentTools, agentStatuses, subagentTools])

  const appendEvent = (
    event: Omit<AgentTimelineEvent, 'eventId' | 'timestamp'> & { type: AgentTimelineEventType },
  ) => {
    const timestamp = Date.now()
    const eventId = `${timestamp}-${eventSeqRef.current++}`
    const nextEvent: AgentTimelineEvent = { ...event, eventId, timestamp }
    setEventLog((prev) => [nextEvent, ...prev].slice(0, MAX_TIMELINE_EVENTS))
  }

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string; folderName?: string }> = []

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const folderName = msg.folderName as string | undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id, undefined, undefined, undefined, undefined, folderName)
        appendEvent({
          type: 'agentCreated',
          agentId: id,
          title: 'Agent created',
          detail: folderName,
          presence: 'idle',
        })
        saveAgentSeats(os)
      } else if (msg.type === 'agentRenamed') {
        const id = msg.id as number
        const folderName = msg.folderName as string | undefined
        if (typeof folderName === 'string') {
          const ch = os.characters.get(id)
          if (ch) ch.folderName = folderName
          appendEvent({
            type: 'agentRenamed',
            agentId: id,
            title: 'Agent renamed',
            detail: folderName,
            presence: deriveAgentPresence(id, agentToolsRef.current, agentStatusesRef.current, subagentToolsRef.current),
          })
        }
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        appendEvent({
          type: 'agentClosed',
          agentId: id,
          title: 'Agent closed',
          presence: 'idle',
        })
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentChats((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentTurnStates((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentProcessStates((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentRequests((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentTodoLists((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentRooms((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string }>
        const folderNames = (msg.folderNames || {}) as Record<number, string>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, folderName: folderNames[id] })
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentTodoList') {
        const id = msg.agentId as number
        const todos = normalizeAgentTodos(msg.todos)
        setAgentTodoLists((prev) => {
          const next = { ...prev }
          if (todos.length === 0) {
            delete next[id]
          } else {
            next[id] = todos
          }
          return next
        })
        const summary = summarizeTodos(todos)
        appendEvent({
          type: 'agentTodoList',
          agentId: id,
          title: 'TODO updated',
          detail: todos.length > 0 ? `${summary.done}/${summary.total} done` : 'cleared',
          presence: deriveAgentPresence(id, agentToolsRef.current, agentStatusesRef.current, subagentToolsRef.current),
        })
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        const isSubtask = status.startsWith('Subtask:')
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        appendEvent({
          type: 'agentToolStart',
          agentId: id,
          title: isSubtask ? 'Subagent started' : 'Tool started',
          detail: compactText(status),
          toolId,
          presence: isSubtask ? 'subagent' : 'active',
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        const targetRoom = roomForToolStatus(status)
        if (targetRoom && routeCharacterToRoom(os, id, targetRoom)) {
          setAgentRooms((prev) => ({ ...prev, [id]: targetRoom }))
          appendEvent({
            type: 'agentRoomRouted',
            agentId: id,
            title: 'Room routed',
            detail: ROOM_LABELS[targetRoom],
            toolId,
            presence: 'active',
          })
          saveAgentSeats(os)
        }
        // Create sub-agent character for Task tool subtasks
        if (isSubtask) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
          if (targetRoom && routeCharacterToRoom(os, subId, targetRoom)) {
            setAgentRooms((prev) => ({ ...prev, [subId]: targetRoom }))
            appendEvent({
              type: 'agentRoomRouted',
              agentId: id,
              title: 'Subagent joins meeting room',
              detail: ROOM_LABELS[targetRoom],
              toolId,
              presence: 'subagent',
            })
          }
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const tool = (agentToolsRef.current[id] || []).find((t) => t.toolId === toolId)
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
        appendEvent({
          type: 'agentToolDone',
          agentId: id,
          title: 'Tool done',
          detail: compactText(tool?.status || toolId),
          toolId,
          presence: deriveAgentPresence(id, agentToolsRef.current, agentStatusesRef.current, subagentToolsRef.current),
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        const subIds = [...os.subagentMeta.entries()]
          .filter(([, meta]) => meta.parentAgentId === id)
          .map(([subId]) => subId)
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setAgentRooms((prev) => {
          if (subIds.length === 0) return prev
          const next = { ...prev }
          for (const subId of subIds) delete next[subId]
          return next
        })
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        appendEvent({
          type: 'agentStatus',
          agentId: id,
          title: status === 'waiting' ? 'Agent waiting' : 'Agent active',
          detail: status,
          presence: status === 'waiting' ? 'waiting' : 'active',
        })
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentChatEntry') {
        const id = msg.agentId as number
        const entry = msg.entry as AgentChatEntry
        const currentList = agentChatsRef.current[id] || []
        const isNewEntry = !currentList.some((item) => item.id === entry.id)
        const nextList = upsertAgentChatEntry(currentList, entry)
        if (nextList !== currentList) {
          agentChatsRef.current = { ...agentChatsRef.current, [id]: nextList }
        }
        setAgentChats((prev) => {
          const list = prev[id] || []
          const updated = upsertAgentChatEntry(list, entry)
          return updated === list ? prev : { ...prev, [id]: updated }
        })
        if (isNewEntry && (entry.role === 'user' || entry.role === 'assistant')) {
          appendEvent({
            type: 'agentChatEntry',
            agentId: id,
            title: entry.role === 'user' ? 'User message' : 'Assistant response',
            detail: compactText(entry.text),
            presence: entry.role === 'user' ? 'active' : deriveAgentPresence(id, agentToolsRef.current, agentStatusesRef.current, subagentToolsRef.current),
          })
          const reportRoom = reportRoomForSubagent()
          if (!hasActiveTool(agentToolsRef.current[id]) && routeCharacterToRoom(os, id, reportRoom)) {
            setAgentRooms((prev) => ({ ...prev, [id]: reportRoom }))
            appendEvent({
              type: 'agentRoomRouted',
              agentId: id,
              title: 'Reporting to PI',
              detail: ROOM_LABELS[reportRoom],
              presence: 'active',
            })
            saveAgentSeats(os)
          }
        }
      } else if (msg.type === 'agentBubble') {
        const id = msg.agentId as number
        const text = msg.text as string
        const kind = msg.kind as AgentBubbleKind
        const ttlMs = typeof msg.ttlMs === 'number' ? msg.ttlMs : undefined
        os.showTextBubble(id, text, kind, ttlMs ? ttlMs / 1000 : undefined)
      } else if (msg.type === 'agentTurnState') {
        const id = msg.agentId as number
        const turnState = msg.turnState as AgentTurnState
        setAgentTurnStates((prev) => ({ ...prev, [id]: turnState }))
        setAgentStatuses((prev) => {
          const next = { ...prev }
          if (turnState === 'running') {
            next[id] = 'running'
          } else if (turnState === 'waiting_for_approval') {
            next[id] = 'waiting for approval'
          } else if (turnState === 'waiting_for_answer') {
            next[id] = 'waiting for answer'
          } else if (turnState === 'error') {
            next[id] = 'error'
          } else {
            delete next[id]
          }
          return next
        })
        os.setAgentActive(id, turnState === 'running' || turnState === 'waiting_for_approval' || turnState === 'waiting_for_answer')
        if (turnState === 'waiting_for_approval') {
          os.showPermissionBubble(id)
        } else if (turnState === 'running' || turnState === 'idle' || turnState === 'cancelled') {
          os.clearPermissionBubble(id)
        }
        appendEvent({
          type: 'agentTurnState',
          agentId: id,
          title: 'Turn state',
          detail: turnState,
          presence: turnState === 'error'
            ? 'error'
            : turnState === 'waiting_for_approval'
              ? 'permission'
              : turnState === 'waiting_for_answer'
                ? 'waiting'
                : turnState === 'running'
                  ? 'active'
                  : 'idle',
        })
      } else if (msg.type === 'agentProcessState') {
        const id = msg.agentId as number
        const state = msg.state as AgentProcessState
        const pid = typeof msg.pid === 'number' ? msg.pid : undefined
        const error = typeof msg.error === 'string' ? msg.error : undefined
        setAgentProcessStates((prev) => ({ ...prev, [id]: { state, pid, error } }))
        setAgentStatuses((prev) => {
          const next = { ...prev }
          if (state === 'starting') next[id] = 'starting'
          if (state === 'ready' && next[id] === 'starting') delete next[id]
          if (state === 'crashed') next[id] = error || 'error'
          if (state === 'exited') next[id] = 'exited'
          return next
        })
        if (state === 'crashed' && error) {
          os.showTextBubble(id, error, 'error', 8)
        }
        appendEvent({
          type: 'agentProcessState',
          agentId: id,
          title: state === 'ready' ? 'Kimi ready' : state === 'starting' ? 'Kimi starting' : state === 'exited' ? 'Kimi exited' : 'Kimi crashed',
          detail: error || (pid ? `pid ${pid}` : state),
          presence: state === 'crashed' ? 'error' : state === 'starting' ? 'active' : 'idle',
        })
      } else if (msg.type === 'agentRequest') {
        const id = msg.agentId as number
        const request = msg.request as AgentRequestMessage
        setAgentRequests((prev) => {
          const list = prev[id] || []
          const nextList = list.some((item) => item.requestId === request.requestId)
            ? list.map((item) => (item.requestId === request.requestId ? request : item))
            : [...list, request]
          return { ...prev, [id]: nextList }
        })
        appendEvent({
          type: 'agentRequest',
          agentId: id,
          title: request.requestType === 'ApprovalRequest' ? 'Approval requested' : 'Input requested',
          detail: compactText(String((request.payload.description || request.payload.action || request.requestType) ?? 'Request')),
          presence: request.requestType === 'ApprovalRequest' ? 'permission' : 'waiting',
        })
        if (request.requestType === 'ApprovalRequest') {
          os.showPermissionBubble(id)
        }
      } else if (msg.type === 'agentRequestResolved') {
        const id = msg.agentId as number
        const requestId = msg.requestId as string
        setAgentRequests((prev) => {
          const list = prev[id]
          if (!list) return prev
          const nextList = list.filter((item) => item.requestId !== requestId)
          return { ...prev, [id]: nextList }
        })
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        appendEvent({
          type: 'agentToolPermission',
          agentId: id,
          title: 'Needs approval',
          detail: 'Parent tool is waiting for permission',
          presence: 'permission',
        })
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        appendEvent({
          type: 'subagentToolPermission',
          agentId: id,
          title: 'Subagent needs approval',
          detail: parentToolId,
          parentToolId,
          presence: 'permission',
        })
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          const list = agentSubs?.[parentToolId]
          if (!agentSubs || !list) return prev
          return {
            ...prev,
            [id]: {
              ...agentSubs,
              [parentToolId]: list.map((tool) => (tool.done ? tool : { ...tool, permissionWait: true })),
            },
          }
        })
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        appendEvent({
          type: 'agentToolPermissionClear',
          agentId: id,
          title: 'Approval cleared',
          presence: deriveAgentPresence(id, agentToolsRef.current, agentStatusesRef.current, subagentToolsRef.current),
        })
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          let changed = false
          const nextSubs: Record<string, ToolActivity[]> = {}
          for (const [parentToolId, list] of Object.entries(agentSubs)) {
            nextSubs[parentToolId] = list.map((tool) => {
              if (!tool.permissionWait) return tool
              changed = true
              return { ...tool, permissionWait: false }
            })
          }
          return changed ? { ...prev, [id]: nextSubs } : prev
        })
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        appendEvent({
          type: 'subagentToolStart',
          agentId: id,
          title: 'Subagent tool started',
          detail: compactText(status),
          parentToolId,
          toolId,
          presence: 'subagent',
        })
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
          const targetRoom = roomForToolStatus(status)
          if (targetRoom && routeCharacterToRoom(os, subId, targetRoom)) {
            setAgentRooms((prev) => ({ ...prev, [subId]: targetRoom }))
            appendEvent({
              type: 'agentRoomRouted',
              agentId: id,
              title: 'Subagent room routed',
              detail: ROOM_LABELS[targetRoom],
              parentToolId,
              toolId,
              presence: 'subagent',
            })
          }
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const tool = subagentToolsRef.current[id]?.[parentToolId]?.find((t) => t.toolId === toolId)
        const remainingActive = (subagentToolsRef.current[id]?.[parentToolId] || []).some((t) => t.toolId !== toolId && !t.done)
        appendEvent({
          type: 'subagentToolDone',
          agentId: id,
          title: 'Subagent tool done',
          detail: compactText(tool?.status || toolId),
          parentToolId,
          toolId,
          presence: deriveAgentPresence(id, agentToolsRef.current, agentStatusesRef.current, subagentToolsRef.current),
        })
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
        if (!remainingActive) {
          const subId = os.getSubagentId(id, parentToolId)
          if (subId !== null) {
            os.setAgentActive(subId, false)
            os.setAgentTool(subId, null)
            os.clearPermissionBubble(subId)
            const reportRoom = reportRoomForSubagent()
            if (routeCharacterToRoom(os, subId, reportRoom)) {
              setAgentRooms((prev) => ({ ...prev, [subId]: reportRoom }))
              appendEvent({
                type: 'agentRoomRouted',
                agentId: id,
                title: 'Subagent reports to PI',
                detail: ROOM_LABELS[reportRoom],
                parentToolId,
                toolId,
                presence: 'subagent',
              })
            }
          }
        }
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const subId = os.getSubagentId(id, parentToolId)
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        if (subId !== null) {
          setAgentRooms((prev) => {
            if (!(subId in prev)) return prev
            const next = { ...prev }
            delete next[subId]
            return next
          })
        }
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'kimiSessions') {
        setKimiSessions((msg.sessions || []) as KimiSessionSummary[])
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState, isEditDirty, onLayoutLoaded])

  return {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    agentPresences,
    agentChats,
    agentTurnStates,
    agentProcessStates,
    agentRequests,
    agentTodoLists,
    agentRooms,
    subagentTools,
    subagentCharacters,
    eventLog,
    layoutReady,
    loadedAssets,
    workspaceFolders,
    kimiSessions,
    setSelectedAgent,
    setAgentRooms,
  }
}
