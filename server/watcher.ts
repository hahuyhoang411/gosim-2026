import { watch } from "chokidar";
import { statSync, readdirSync, openSync, readSync, closeSync, existsSync } from "fs";
import { join, basename, dirname, sep } from "path";
import { EventEmitter } from "events";
import { KIMI_SESSIONS_DIR, fallbackNameFromSessionDir, sessionDisplayTitle } from "./kimiMetadata.js";

// kimi-cli stores sessions at:
//   ~/.kimi/sessions/<workdir-md5>/<session-id>/{context.jsonl, wire.jsonl, state.json}
// and subagent instances at:
//   ~/.kimi/sessions/<workdir-md5>/<session-id>/subagents/<agent-id>/context.jsonl
const ACTIVE_THRESHOLD_MS = 600_000;
const POLL_INTERVAL_MS = 1000;
const PROJECT_NAME_MAX_LENGTH = 24;

export type FileKind = "parent" | "subagent";

export interface WatchedFile {
  kind: FileKind;
  path: string;
  sessionId: string;            // parent session id (for both parent and subagent files)
  projectName: string;           // only meaningful for parent
  offset: number;
  lineBuffer: string;
  // Parent-only: state.json mtime + last title we observed (for rename detection)
  stateMtime?: number;
  lastTitle?: string;
  // Subagent-only:
  subagentId?: string;           // the kimi "aXXXXXXXX" identifier
  parentToolId?: string;         // the parent's "Agent" tool_call_id this subagent fulfills
}

function projectNameFromSession(sessionDir: string, contextPath: string): { title: string; stateMtime?: number } {
  return sessionDisplayTitle(
    sessionDir,
    contextPath,
    fallbackNameFromSessionDir(sessionDir),
    PROJECT_NAME_MAX_LENGTH,
  );
}

export class JsonlWatcher extends EventEmitter {
  private files = new Map<string, WatchedFile>();
  private watcher: ReturnType<typeof watch> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.scanForActiveFiles();

    this.watcher = watch(KIMI_SESSIONS_DIR, {
      ignoreInitial: true,
      depth: 5, // sessions/<workdir>/<session>/subagents/<aid>/context.jsonl is 5 levels deep
    });

    this.watcher.on("add", (filePath: string) => {
      if (basename(filePath) === "context.jsonl") {
        this.addFile(filePath);
      }
    });

    this.pollInterval = setInterval(() => this.pollFiles(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.watcher?.close();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  private classify(filePath: string): { kind: FileKind; sessionId: string; sessionDir: string; subagentId?: string } | null {
    // Parent: <KIMI>/<workdir>/<session>/context.jsonl  → 4 path segments after KIMI_SESSIONS_DIR + filename
    // Subagent: <KIMI>/<workdir>/<session>/subagents/<aid>/context.jsonl
    const rel = filePath.startsWith(KIMI_SESSIONS_DIR + sep) ? filePath.slice(KIMI_SESSIONS_DIR.length + 1) : filePath;
    const parts = rel.split(sep);
    if (parts.length === 3 && parts[2] === "context.jsonl") {
      const sessionDir = join(KIMI_SESSIONS_DIR, parts[0], parts[1]);
      return { kind: "parent", sessionId: parts[1], sessionDir };
    }
    if (parts.length === 5 && parts[2] === "subagents" && parts[4] === "context.jsonl") {
      const sessionDir = join(KIMI_SESSIONS_DIR, parts[0], parts[1]);
      return { kind: "subagent", sessionId: parts[1], sessionDir, subagentId: parts[3] };
    }
    return null;
  }

  private scanForActiveFiles(): void {
    try {
      const workdirDirs = readdirSync(KIMI_SESSIONS_DIR, { withFileTypes: true });
      for (const wd of workdirDirs) {
        if (!wd.isDirectory()) continue;
        const wdPath = join(KIMI_SESSIONS_DIR, wd.name);
        let sessionDirs: import("fs").Dirent[];
        try {
          sessionDirs = readdirSync(wdPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sd of sessionDirs) {
          if (!sd.isDirectory()) continue;
          const sessionDir = join(wdPath, sd.name);
          const ctxPath = join(sessionDir, "context.jsonl");
          if (existsSync(ctxPath)) {
            try {
              const stat = statSync(ctxPath);
              if (Date.now() - stat.mtimeMs < ACTIVE_THRESHOLD_MS) {
                this.addFile(ctxPath);
              }
            } catch {
              /* skip */
            }
          }
          // Also pick up any active subagent files for this session
          const subRoot = join(sessionDir, "subagents");
          if (existsSync(subRoot)) {
            try {
              const subDirs = readdirSync(subRoot, { withFileTypes: true });
              for (const sub of subDirs) {
                if (!sub.isDirectory()) continue;
                const subCtx = join(subRoot, sub.name, "context.jsonl");
                if (!existsSync(subCtx)) continue;
                const stat = statSync(subCtx);
                if (Date.now() - stat.mtimeMs < ACTIVE_THRESHOLD_MS) {
                  this.addFile(subCtx);
                }
              }
            } catch {
              /* skip */
            }
          }
        }
      }
    } catch {
      /* sessions dir may not exist yet */
    }
  }

  private addFile(filePath: string): void {
    if (this.files.has(filePath)) return;

    const cls = this.classify(filePath);
    if (!cls) return;

    if (cls.kind === "parent") {
      const sessionDir = cls.sessionDir;
      const display = projectNameFromSession(sessionDir, filePath);

      const file: WatchedFile = {
        kind: "parent",
        path: filePath,
        sessionId: cls.sessionId,
        projectName: display.title,
        offset: 0,
        lineBuffer: "",
        stateMtime: display.stateMtime,
        lastTitle: display.title,
      };

      this.files.set(filePath, file);
      this.emit("fileAdded", file);
      this.readNewLines(file);
      return;
    }

    // subagent
    const file: WatchedFile = {
      kind: "subagent",
      path: filePath,
      sessionId: cls.sessionId,
      projectName: "",
      offset: 0,
      lineBuffer: "",
      subagentId: cls.subagentId,
    };

    this.files.set(filePath, file);
    this.emit("fileAdded", file);
    this.readNewLines(file);
  }

  private pollFiles(): void {
    for (const [path, file] of this.files) {
      try {
        const stat = statSync(path);
        if (stat.size > file.offset) {
          this.readNewLines(file);
        }
        // Parent-only: detect title change in state.json
        if (file.kind === "parent") {
          this.checkParentRename(file);
        }
        // Stale-file cleanup
        if (Date.now() - stat.mtimeMs > ACTIVE_THRESHOLD_MS) {
          this.files.delete(path);
          this.emit("fileRemoved", file);
        }
      } catch {
        this.files.delete(path);
        this.emit("fileRemoved", file);
      }
    }
  }

  private checkParentRename(file: WatchedFile): void {
    const sessionDir = dirname(file.path);
    const next = projectNameFromSession(sessionDir, file.path);
    file.stateMtime = next.stateMtime;
    if (next.title === file.lastTitle && next.title === file.projectName) return;
    file.lastTitle = next.title;
    const newName = next.title;
    if (newName === file.projectName) return;
    file.projectName = newName;
    this.emit("fileRenamed", file);
  }

  private readNewLines(file: WatchedFile): void {
    try {
      const stat = statSync(file.path);
      if (stat.size <= file.offset) return;

      const buf = Buffer.alloc(stat.size - file.offset);
      const fd = openSync(file.path, "r");
      readSync(fd, buf, 0, buf.length, file.offset);
      closeSync(fd);

      file.offset = stat.size;
      const text = file.lineBuffer + buf.toString("utf-8");
      const lines = text.split("\n");

      file.lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.emit("line", file, line);
        }
      }
    } catch {
      /* file may have been deleted */
    }
  }

  getActiveFiles(): WatchedFile[] {
    return Array.from(this.files.values());
  }
}
