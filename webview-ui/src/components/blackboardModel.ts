export type AgentTodoStatus = 'pending' | 'in_progress' | 'done'

export interface AgentTodoItem {
  title: string
  status: AgentTodoStatus
}

export interface TodoSummary {
  total: number
  done: number
  inProgress: number
  pending: number
}

export interface BlackboardSection {
  agentId: number
  todos: AgentTodoItem[]
  summary: TodoSummary
}

const TODO_STATUSES = new Set<AgentTodoStatus>(['pending', 'in_progress', 'done'])

function normalizeTodoStatus(value: unknown): AgentTodoStatus {
  return typeof value === 'string' && TODO_STATUSES.has(value as AgentTodoStatus)
    ? value as AgentTodoStatus
    : 'pending'
}

export function normalizeAgentTodos(value: unknown): AgentTodoItem[] {
  if (!Array.isArray(value)) return []
  const todos: AgentTodoItem[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (!title) continue
    todos.push({ title, status: normalizeTodoStatus(record.status) })
  }
  return todos
}

export function summarizeTodos(todos: AgentTodoItem[]): TodoSummary {
  const summary: TodoSummary = { total: todos.length, done: 0, inProgress: 0, pending: 0 }
  for (const todo of todos) {
    if (todo.status === 'done') summary.done += 1
    else if (todo.status === 'in_progress') summary.inProgress += 1
    else summary.pending += 1
  }
  return summary
}

export function buildBlackboardSections(
  agents: number[],
  agentTodoLists: Record<number, AgentTodoItem[]>,
): BlackboardSection[] {
  const known = new Set(agents)
  const extraAgentIds = Object.keys(agentTodoLists)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && !known.has(id))
    .sort((a, b) => a - b)
  const orderedAgentIds = [...agents, ...extraAgentIds]

  return orderedAgentIds.flatMap((agentId) => {
    const todos = agentTodoLists[agentId] || []
    if (todos.length === 0) return []
    return [{ agentId, todos, summary: summarizeTodos(todos) }]
  })
}
