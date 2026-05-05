import type { AgentPresence, ToolActivity } from './types.js'

export interface PresenceMeta {
  label: string
  color: string
  shortLabel: string
}

const ERROR_RE = /\b(error|failed|failure|exception|traceback|panic)\b/i

export const PRESENCE_META: Record<AgentPresence, PresenceMeta> = {
  idle: {
    label: 'Idle',
    shortLabel: 'Idle',
    color: 'var(--pixel-status-idle)',
  },
  active: {
    label: 'Active',
    shortLabel: 'Work',
    color: 'var(--pixel-status-active)',
  },
  subagent: {
    label: 'Subagent active',
    shortLabel: 'Sub',
    color: 'var(--pixel-status-subagent)',
  },
  permission: {
    label: 'Needs approval',
    shortLabel: 'Approval',
    color: 'var(--pixel-status-permission)',
  },
  waiting: {
    label: 'Waiting',
    shortLabel: 'Wait',
    color: 'var(--pixel-status-waiting)',
  },
  error: {
    label: 'Error',
    shortLabel: 'Error',
    color: 'var(--pixel-status-error)',
  },
}

export function isErrorLike(text: string | undefined): boolean {
  return Boolean(text && ERROR_RE.test(text))
}

export function flattenSubagentTools(agentSubs: Record<string, ToolActivity[]> | undefined): ToolActivity[] {
  if (!agentSubs) return []
  return Object.values(agentSubs).flat()
}

export function deriveAgentPresence(
  id: number,
  agentTools: Record<number, ToolActivity[]>,
  agentStatuses: Record<number, string>,
  subagentTools: Record<number, Record<string, ToolActivity[]>>,
): AgentPresence {
  const status = agentStatuses[id]
  const tools = agentTools[id] || []
  const subTools = flattenSubagentTools(subagentTools[id])

  if (isErrorLike(status) || tools.some((tool) => isErrorLike(tool.status)) || subTools.some((tool) => isErrorLike(tool.status))) {
    return 'error'
  }
  if (tools.some((tool) => tool.permissionWait && !tool.done) || subTools.some((tool) => tool.permissionWait && !tool.done)) {
    return 'permission'
  }
  if (subTools.some((tool) => !tool.done)) {
    return 'subagent'
  }
  if (status === 'waiting') {
    return 'waiting'
  }
  if (tools.some((tool) => !tool.done)) {
    return 'active'
  }
  return 'idle'
}

export function getPresenceMeta(presence: AgentPresence): PresenceMeta {
  return PRESENCE_META[presence]
}
