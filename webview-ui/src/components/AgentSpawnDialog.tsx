import { useEffect, useRef, useState, type CSSProperties } from 'react'

export interface SpawnKimiAgentInput {
  workdirPath: string
  prompt: string
  planMode: boolean
}

interface AgentSpawnDialogProps {
  defaultWorkdir?: string
  onClose: () => void
  onSpawn: (input: SpawnKimiAgentInput) => void
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'var(--pixel-text)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '5px 7px',
  fontSize: 18,
  outline: 'none',
}

const labelStyle: CSSProperties = {
  fontSize: 17,
  color: 'var(--pixel-text-dim)',
  textTransform: 'uppercase',
}

export function AgentSpawnDialog({ defaultWorkdir = '', onClose, onSpawn }: AgentSpawnDialogProps) {
  const [workdirPath, setWorkdirPath] = useState(defaultWorkdir)
  const [prompt, setPrompt] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setTimeout(() => promptRef.current?.focus(), 0)
  }, [])

  const handleSpawn = () => {
    onSpawn({ workdirPath: workdirPath.trim(), prompt: prompt.trim(), planMode })
    onClose()
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        width: 360,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-agent-border)',
        borderRadius: 0,
        boxShadow: 'var(--pixel-shadow)',
        padding: 10,
        zIndex: 'var(--pixel-controls-z)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <div style={labelStyle}>New Kimi Agent</div>
          <div style={{ fontSize: 18, color: 'var(--vscode-foreground)' }}>Spawn Wire session in the office</div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--pixel-text-dim)',
            cursor: 'pointer',
            fontSize: 22,
          }}
          title="Close"
        >
          ×
        </button>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={labelStyle}>Workdir</span>
        <input
          value={workdirPath}
          onChange={(e) => setWorkdirPath(e.target.value)}
          placeholder="Leave blank for current project"
          style={inputStyle}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={labelStyle}>Initial prompt</span>
        <textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSpawn()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="What should this agent work on?"
          rows={4}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 90 }}
        />
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 18, color: 'var(--pixel-text)' }}>
        <input
          type="checkbox"
          checked={planMode}
          onChange={(e) => setPlanMode(e.target.checked)}
        />
        Start in plan mode
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button
          onClick={onClose}
          style={{
            background: 'var(--pixel-btn-bg)',
            color: 'var(--pixel-text-dim)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            padding: '5px 9px',
            fontSize: 20,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSpawn}
          style={{
            background: 'var(--pixel-agent-bg)',
            color: 'var(--pixel-agent-text)',
            border: '2px solid var(--pixel-agent-border)',
            borderRadius: 0,
            padding: '5px 9px',
            fontSize: 20,
            cursor: 'pointer',
          }}
        >
          Spawn
        </button>
      </div>
    </div>
  )
}
