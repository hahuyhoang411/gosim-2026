import { useState, useEffect, useRef } from 'react'
import { SettingsModal } from './SettingsModal.js'
import { AgentSpawnDialog, type SpawnKimiAgentInput } from './AgentSpawnDialog.js'
import type { KimiSessionSummary } from '../hooks/useExtensionMessages.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  kimiSessions: KimiSessionSummary[]
  onRefreshKimiSessions: () => void
  onResumeKimiSession: (session: KimiSessionSummary) => void
  onSpawnKimiAgent: (input: SpawnKimiAgentInput) => void
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}


export function BottomToolbar({
  isEditMode,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  kimiSessions,
  onRefreshKimiSessions,
  onResumeKimiSession,
  onSpawnKimiAgent,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isSessionPickerOpen, setIsSessionPickerOpen] = useState(false)
  const [isSpawnDialogOpen, setIsSpawnDialogOpen] = useState(false)
  const [hoveredSession, setHoveredSession] = useState<string | null>(null)
  const sessionPickerRef = useRef<HTMLDivElement>(null)

  // Close session picker on outside click
  useEffect(() => {
    if (!isSessionPickerOpen && !isSpawnDialogOpen) return
    const handleClick = (e: MouseEvent) => {
      if (sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setIsSessionPickerOpen(false)
        setIsSpawnDialogOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isSessionPickerOpen, isSpawnDialogOpen])

  const handleAgentClick = () => {
    onRefreshKimiSessions()
    setIsSessionPickerOpen((v) => !v)
    setIsSpawnDialogOpen(false)
  }

  const handleSessionSelect = (session: KimiSessionSummary) => {
    setIsSessionPickerOpen(false)
    onResumeKimiSession(session)
  }

  const formatTime = (timestamp: number) => {
    if (!timestamp) return ''
    return new Date(timestamp).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div style={panelStyle}>
      <div ref={sessionPickerRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '5px 12px',
            background:
              hovered === 'agent' || isSessionPickerOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
        >
          + Agent
        </button>
        {isSessionPickerOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              marginBottom: 4,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: 'var(--pixel-shadow)',
              width: 330,
              maxHeight: 360,
              overflow: 'auto',
              zIndex: 'var(--pixel-controls-z)',
            }}
          >
            <button
              onClick={() => {
                setIsSessionPickerOpen(false)
                setIsSpawnDialogOpen(true)
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                fontSize: '22px',
                color: 'var(--pixel-agent-text)',
                background: 'var(--pixel-agent-bg)',
                border: 'none',
                borderBottom: '2px solid var(--pixel-border)',
                cursor: 'pointer',
              }}
            >
              New Kimi Agent…
              <span style={{ display: 'block', color: 'var(--pixel-text-dim)', fontSize: 16 }}>
                Chat directly through Wire, no Terminal
              </span>
            </button>
            {kimiSessions.length === 0 ? (
              <div
                style={{
                  padding: '8px 10px',
                  fontSize: '22px',
                  color: 'var(--pixel-text-dim)',
                }}
              >
                No Kimi sessions
              </div>
            ) : kimiSessions.map((session) => (
              <button
                key={`${session.workdirHash}:${session.sessionId}`}
                onClick={() => handleSessionSelect(session)}
                onMouseEnter={() => setHoveredSession(session.sessionId)}
                onMouseLeave={() => setHoveredSession(null)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 6,
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  fontSize: '20px',
                  color: 'var(--pixel-text)',
                  background: hoveredSession === session.sessionId ? 'var(--pixel-btn-hover-bg)' : 'transparent',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  minWidth: 0,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--vscode-foreground)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {session.title}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--pixel-text-dim)',
                      fontSize: '16px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {session.workdirPath || session.workdirHash}
                  </span>
                </span>
                <span style={{ color: session.active ? 'var(--pixel-status-active)' : 'var(--pixel-text-dim)', fontSize: '16px', whiteSpace: 'nowrap' }}>
                  {session.active ? 'Active' : formatTime(session.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
        {isSpawnDialogOpen && (
          <AgentSpawnDialog
            defaultWorkdir={kimiSessions.find((s) => s.workdirPath)?.workdirPath || ''}
            onClose={() => setIsSpawnDialogOpen(false)}
            onSpawn={onSpawnKimiAgent}
          />
        )}
      </div>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>
    </div>
  )
}
