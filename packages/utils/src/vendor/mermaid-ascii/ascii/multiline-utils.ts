
import type { Canvas } from './types'
import { drawText } from './canvas'
import { displayWidth } from '../text-metrics'

export function splitLines(label: string): string[] {
  return label.split('\n')
}

export function maxLineWidth(label: string): number {
  const lines = splitLines(label)
  return Math.max(...lines.map(l => displayWidth(l)), 0)
}

export function lineCount(label: string): number {
  return splitLines(label).length
}

export function drawMultilineTextCentered(
  canvas: Canvas,
  label: string,
  cx: number,
  cy: number
): void {
  const lines = splitLines(label)
  const totalHeight = lines.length
  const startY = cy - Math.floor((totalHeight - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const startX = cx - Math.floor(displayWidth(line) / 2)
    drawText(canvas, { x: startX, y: startY + i }, line, true)
  }
}

export function drawMultilineTextLeft(
  canvas: Canvas,
  label: string,
  x: number,
  y: number
): void {
  const lines = splitLines(label)
  for (let i = 0; i < lines.length; i++) {
    drawText(canvas, { x, y: y + i }, lines[i]!, true)
  }
}
