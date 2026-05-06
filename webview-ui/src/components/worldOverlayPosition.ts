import type { RefObject } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { TILE_SIZE } from '../office/types.js'

export interface ScreenPosition {
  x: number
  y: number
}

export function worldTileToScreen(
  officeState: OfficeState,
  containerRef: RefObject<HTMLDivElement | null>,
  zoom: number,
  panRef: RefObject<{ x: number; y: number }>,
  col: number,
  row: number,
): ScreenPosition | null {
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

  return {
    x: (deviceOffsetX + (col + 0.5) * TILE_SIZE * zoom) / dpr,
    y: (deviceOffsetY + (row + 0.5) * TILE_SIZE * zoom) / dpr,
  }
}
