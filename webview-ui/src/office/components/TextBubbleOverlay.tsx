import { useEffect, useState } from 'react'
import type { OfficeState } from '../engine/officeState.js'
import { TILE_SIZE, CharacterState, type Character } from '../types.js'
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
} from '../../constants.js'

interface TextBubbleOverlayProps {
  officeState: OfficeState
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
}

function bubblePalette(kind: Character['bubbleKind']): { fill: string; stroke: string; text: string } {
  switch (kind) {
    case 'user':
      return { fill: '#dff3ff', stroke: '#5a8cff', text: '#122033' }
    case 'steer':
      return { fill: '#fff1cf', stroke: '#d18616', text: '#2b1b00' }
    case 'system':
      return { fill: '#eceaff', stroke: '#8f7af5', text: '#1d1738' }
    case 'error':
      return { fill: '#ffe0dc', stroke: '#f48771', text: '#3b0905' }
    case 'assistant':
    default:
      return { fill: '#efffec', stroke: '#5ac88c', text: '#102414' }
  }
}

export function TextBubbleOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: TextBubbleOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null

  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  return (
    <>
      {officeState.getCharacters().map((ch) => {
        const text = ch.bubbleText?.replace(/\s+/g, ' ').trim()
        if (ch.bubbleType !== 'text' || !text) return null

        const sittingOffset = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0
        const anchorX = (deviceOffsetX + ch.x * zoom) / dpr
        const anchorY = (deviceOffsetY + (ch.y + sittingOffset - BUBBLE_VERTICAL_OFFSET_PX) * zoom) / dpr
        const scale = Math.max(1, zoom / dpr)
        const palette = bubblePalette(ch.bubbleKind)
        const alpha = ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
          ? Math.max(0, ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC)
          : 1

        return (
          <div
            key={ch.id}
            style={{
              position: 'absolute',
              left: anchorX,
              top: anchorY - Math.max(4, Math.round(4 * scale)),
              transform: 'translate(-50%, -100%)',
              zIndex: 120,
              pointerEvents: 'none',
              opacity: alpha,
              filter: `drop-shadow(${Math.round(2 * scale)}px ${Math.round(2 * scale)}px 0 rgba(0, 0, 0, 0.32))`,
            }}
          >
            <div
              style={{
                position: 'relative',
                maxWidth: Math.max(150, Math.round(150 * scale)),
                padding: `${Math.max(4, Math.round(4 * scale))}px ${Math.max(6, Math.round(6 * scale))}px`,
                background: palette.fill,
                border: `${Math.max(1, Math.round(1.5 * scale))}px solid ${palette.stroke}`,
                borderRadius: Math.max(3, Math.round(3 * scale)),
                color: palette.text,
                fontSize: Math.max(13, Math.round(9 * scale)),
                lineHeight: 1.18,
                whiteSpace: 'normal',
                overflowWrap: 'break-word',
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {text}
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: -Math.max(5, Math.round(5 * scale)),
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: `${Math.max(4, Math.round(4 * scale))}px solid transparent`,
                  borderRight: `${Math.max(4, Math.round(4 * scale))}px solid transparent`,
                  borderTop: `${Math.max(5, Math.round(5 * scale))}px solid ${palette.stroke}`,
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: -Math.max(3, Math.round(3 * scale)),
                  transform: 'translateX(-50%)',
                  width: 0,
                  height: 0,
                  borderLeft: `${Math.max(3, Math.round(3 * scale))}px solid transparent`,
                  borderRight: `${Math.max(3, Math.round(3 * scale))}px solid transparent`,
                  borderTop: `${Math.max(4, Math.round(4 * scale))}px solid ${palette.fill}`,
                }}
              />
            </div>
          </div>
        )
      })}
    </>
  )
}
