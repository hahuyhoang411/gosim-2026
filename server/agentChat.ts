import type { AgentChatEntry, AgentChatRole } from "./types.js";

export interface StreamingChatState {
  activeEntryId: string | null;
}

interface AppendStreamingChatTextInput {
  conversation: AgentChatEntry[];
  stream: StreamingChatState;
  role: AgentChatRole;
  text: string;
  createEntry: () => AgentChatEntry;
}

export function resetStreamingChat(stream: StreamingChatState): void {
  stream.activeEntryId = null;
}

export function appendStreamingChatText({
  conversation,
  stream,
  role,
  text,
  createEntry,
}: AppendStreamingChatTextInput): { entry: AgentChatEntry; isUpdate: boolean } {
  const activeIndex = stream.activeEntryId
    ? conversation.findIndex((entry) => entry.id === stream.activeEntryId)
    : -1;
  const active = activeIndex >= 0 ? conversation[activeIndex] : undefined;

  if (active && active.role === role && active.source === "wire") {
    const entry = { ...active, text: `${active.text}${text}` };
    conversation[activeIndex] = entry;
    return { entry, isUpdate: true };
  }

  const entry = createEntry();
  conversation.push(entry);
  stream.activeEntryId = entry.id;
  return { entry, isUpdate: false };
}
