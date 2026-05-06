import type { AgentChatEntry, AgentChatRole, AgentRequestMessage } from "./types.js";
import {
  contentInputText,
  contentPartText,
  requestDisplayText,
  type WireEventParams,
  type WireRequestEnvelope,
} from "./kimiWire.js";

export interface StoredWireRequest {
  rpcId: string;
  requestId: string;
  requestType: string;
  payload: Record<string, unknown>;
}

export interface WireConversationState {
  agentId: number;
  entries: AgentChatEntry[];
  pendingRequests: Map<string, StoredWireRequest>;
  nextEntryId: number;
  seenEntryKeys: Set<string>;
}

export interface AppendEntryOptions {
  id?: string;
  createdAt?: number;
  dedupeKey?: string;
}

export interface WireConversationSnapshot {
  entries: AgentChatEntry[];
  requests: AgentRequestMessage[];
}

export interface RegisterWireRequestResult {
  request: StoredWireRequest;
  entry: AgentChatEntry | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestPayload(request: WireRequestEnvelope): Record<string, unknown> {
  return request.params.payload && typeof request.params.payload === "object" && !Array.isArray(request.params.payload)
    ? request.params.payload as Record<string, unknown>
    : {};
}

export function wireRequestId(request: WireRequestEnvelope): string {
  const payload = requestPayload(request);
  return typeof payload.id === "string" ? payload.id : request.rpcId;
}

export function createWireConversationState(agentId: number): WireConversationState {
  return {
    agentId,
    entries: [],
    pendingRequests: new Map(),
    nextEntryId: 1,
    seenEntryKeys: new Set(),
  };
}

export function appendWireConversationEntry(
  state: WireConversationState,
  role: AgentChatRole,
  text: string,
  source: AgentChatEntry["source"] = "wire",
  options: AppendEntryOptions = {},
): AgentChatEntry | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const dedupeKey = options.dedupeKey ?? options.id;
  if (dedupeKey && state.seenEntryKeys.has(dedupeKey)) return null;

  const createdAt = options.createdAt ?? Date.now();
  const entry: AgentChatEntry = {
    id: options.id ?? `${createdAt}-${state.nextEntryId++}`,
    agentId: state.agentId,
    role,
    text: normalized,
    createdAt,
    source,
  };
  state.entries.push(entry);
  if (dedupeKey) state.seenEntryKeys.add(dedupeKey);
  return entry;
}

export function registerWireRequest(
  state: WireConversationState,
  request: WireRequestEnvelope,
): RegisterWireRequestResult {
  const payload = requestPayload(request);
  const requestType = request.params.type || "Request";
  const requestId = wireRequestId(request);
  const stored: StoredWireRequest = {
    rpcId: request.rpcId,
    requestId,
    requestType,
    payload,
  };
  state.pendingRequests.set(requestId, stored);
  const entry = appendWireConversationEntry(
    state,
    "system",
    requestDisplayText({ type: requestType, payload }),
    "request",
    { dedupeKey: `request:${requestId}` },
  );
  return { request: stored, entry };
}

export function applyReplayWireRequest(
  state: WireConversationState,
  request: WireRequestEnvelope,
): AgentChatEntry | null {
  const payload = requestPayload(request);
  const requestType = request.params.type || "Request";
  const requestId = wireRequestId(request);
  return appendWireConversationEntry(
    state,
    "system",
    requestDisplayText({ type: requestType, payload }),
    "request",
    { dedupeKey: `replay-request:${requestId}` },
  );
}

export function resolveWireRequest(state: WireConversationState, requestId: string): boolean {
  return state.pendingRequests.delete(requestId);
}

export function applyReplayWireEvent(state: WireConversationState, event: WireEventParams): AgentChatEntry | null {
  const payload = asRecord(event.payload);
  switch (event.type) {
    case "TurnBegin": {
      const text = contentInputText(payload.user_input);
      return appendWireConversationEntry(state, "user", text, "prompt", { dedupeKey: `replay-turn:${text}` });
    }
    case "StepInterrupted":
      return appendWireConversationEntry(state, "system", "Step interrupted.", "system", { dedupeKey: "replay-step-interrupted" });
    case "ContentPart": {
      const part = contentPartText(payload);
      if (!part) return null;
      return appendWireConversationEntry(
        state,
        part.role,
        part.text,
        "wire",
        { dedupeKey: `replay-content:${part.role}:${part.text}` },
      );
    }
    case "SteerInput": {
      const text = contentInputText(payload.user_input);
      return appendWireConversationEntry(
        state,
        "system",
        `Steer accepted: ${text}`,
        "steer",
        { dedupeKey: `replay-steer:${text}` },
      );
    }
    case "PlanDisplay": {
      const content = typeof payload.content === "string" ? payload.content : "";
      const filePath = typeof payload.file_path === "string" ? payload.file_path : "";
      return appendWireConversationEntry(
        state,
        "assistant",
        `${filePath ? `Plan: ${filePath}\n\n` : ""}${content}`,
        "wire",
        { dedupeKey: `replay-plan:${filePath}:${content}` },
      );
    }
    case "BtwEnd": {
      const response = typeof payload.response === "string" ? payload.response : "";
      const error = typeof payload.error === "string" ? payload.error : "";
      if (response) {
        return appendWireConversationEntry(state, "assistant", response, "wire", { dedupeKey: `replay-btw-response:${response}` });
      }
      if (error) {
        return appendWireConversationEntry(state, "system", error, "system", { dedupeKey: `replay-btw-error:${error}` });
      }
      return null;
    }
    case "ApprovalResponse": {
      const requestId = typeof payload.request_id === "string" ? payload.request_id : "";
      if (requestId) resolveWireRequest(state, requestId);
      return null;
    }
    default:
      return null;
  }
}

export function wireConversationSnapshot(state: WireConversationState): WireConversationSnapshot {
  return {
    entries: [...state.entries],
    requests: [...state.pendingRequests.values()].map((request) => ({
      requestId: request.requestId,
      requestType: request.requestType,
      payload: request.payload,
    })),
  };
}
