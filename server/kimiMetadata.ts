import { createHash } from "crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import type { KimiSessionSummary } from "./types.js";

const KIMI_DIR = join(homedir(), ".kimi");
const KIMI_STATE_PATH = join(KIMI_DIR, "kimi.json");
const TITLE_SCAN_BYTES = 256 * 1024;

export const KIMI_SESSIONS_DIR = join(KIMI_DIR, "sessions");

function workdirHash(path: string): string {
  return createHash("md5").update(path).digest("hex");
}

function truncateTitle(title: string, maxLength: number): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return clean;
  return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 1))}…` : clean;
}

function readKimiWorkdirMap(): Map<string, string> {
  const byHash = new Map<string, string>();
  try {
    const data = JSON.parse(readFileSync(KIMI_STATE_PATH, "utf-8")) as {
      work_dirs?: Array<{ path?: string }>;
    };
    for (const entry of data.work_dirs || []) {
      if (entry.path) byHash.set(workdirHash(entry.path), entry.path);
    }
  } catch {
    /* kimi.json may not exist before the first CLI run */
  }
  return byHash;
}

function readSessionStateTitle(sessionDir: string): { title?: string; mtime?: number } {
  try {
    const statePath = join(sessionDir, "state.json");
    if (!existsSync(statePath)) return {};
    const stat = statSync(statePath);
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { title?: string; custom_title?: string };
    return { title: state.title || state.custom_title, mtime: stat.mtimeMs };
  } catch {
    return {};
  }
}

function readInitialChunk(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(TITLE_SCAN_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join(" ");

  return text || undefined;
}

function readFirstUserPrompt(contextPath: string): string | undefined {
  for (const line of readInitialChunk(contextPath).split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.role !== "user") continue;
      return textFromContent(record.content);
    } catch {
      continue;
    }
  }
  return undefined;
}

export function fallbackNameFromSessionDir(sessionDir: string): string {
  return basename(dirname(sessionDir)).slice(0, 6) || basename(sessionDir).slice(0, 8) || "session";
}

export function sessionDisplayTitle(
  sessionDir: string,
  contextPath: string,
  fallback: string,
  maxLength: number,
): { title: string; stateMtime?: number } {
  const state = readSessionStateTitle(sessionDir);
  const title = state.title || readFirstUserPrompt(contextPath) || fallback;
  return { title: truncateTitle(title, maxLength) || fallback, stateMtime: state.mtime };
}

export function listKimiSessions(activeSessionIds = new Set<string>(), limit = Number.POSITIVE_INFINITY): KimiSessionSummary[] {
  const workdirs = readKimiWorkdirMap();
  if (!existsSync(KIMI_SESSIONS_DIR)) return [];

  const sessions: KimiSessionSummary[] = [];
  for (const wd of readdirSync(KIMI_SESSIONS_DIR, { withFileTypes: true })) {
    if (!wd.isDirectory()) continue;
    const workdirHashValue = wd.name;
    const workdirPath = workdirs.get(workdirHashValue);
    const workdirDir = join(KIMI_SESSIONS_DIR, workdirHashValue);

    let sessionDirs: import("fs").Dirent[];
    try {
      sessionDirs = readdirSync(workdirDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      const sessionId = sd.name;
      const sessionDir = join(workdirDir, sessionId);
      const contextPath = join(sessionDir, "context.jsonl");
      if (!existsSync(contextPath)) continue;

      let updatedAt = 0;
      try {
        updatedAt = statSync(contextPath).mtimeMs;
      } catch {
        /* leave as 0 */
      }

      sessions.push({
        sessionId,
        workdirHash: workdirHashValue,
        workdirPath,
        title: sessionDisplayTitle(sessionDir, contextPath, fallbackNameFromSessionDir(sessionDir), 48).title,
        updatedAt,
        active: activeSessionIds.has(sessionId),
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
