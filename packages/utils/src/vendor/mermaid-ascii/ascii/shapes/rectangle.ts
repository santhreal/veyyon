
import type { Canvas, DrawingCoord, Direction } from '../types'
import { Up, Down, Left, Right, UpperLeft, UpperRight, LowerLeft, LowerRight, Middle } from '../types'
import { mkCanvas } from '../canvas'
import { splitLines } from '../multiline-utils'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions } from './types'
import { dirEquals } from '../edge-routing'
import { type CornerChars, getCorners } from './corners'
import { displayWidth, toCells } from '../../text-metrics'


export function getBoxDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions {
  const lines = splitLines(label)
  const maxLineWidth = Math.max(...lines.map(l => displayWidth(l)), 0)
  const lineCount = lines.length

  const innerWidth = 2 * options.padding + maxLineWidth
  const width = innerWidth + 2

  const rawInnerHeight = lineCount + 2 * options.padding
  const innerHeight = rawInnerHeight % 2 === 0 ? rawInnerHeight + 1 : rawInnerHeight
  const height = innerHeight + 2

  return {
    width,
    height,
    labelArea: {
      x: 1 + options.padding,
      y: 1 + options.padding,
      width: maxLineWidth,
      height: lineCount,
    },
    gridColumns: [1, innerWidth, 1],
    gridRows: [1, innerHeight, 1],
  }
}


export function renderBox(
  label: string,
  dimensions: ShapeDimensions,
  corners: CornerChars,
  useAscii: boolean
): Canvas {
  const { width, height } = dimensions
  const canvas = mkCanvas(width - 1, height - 1)

  const from = { x: 0, y: 0 }
  const to = { x: width - 1, y: height - 1 }

  const hLine = useAscii ? '-' : '─'
  const vLine = useAscii ? '|' : '│'

  for (let x = from.x + 1; x < to.x; x++) {
    canvas[x]![from.y] = hLine
    canvas[x]![to.y] = hLine
  }

  for (let y = from.y + 1; y < to.y; y++) {
    canvas[from.x]![y] = vLine
    canvas[to.x]![y] = vLine
  }

  canvas[from.x]![from.y] = corners.tl
  canvas[to.x]![from.y] = corners.tr
  canvas[from.x]![to.y] = corners.bl
  canvas[to.x]![to.y] = corners.br

  const lines = splitLines(label)
  const w = width - 1  // Match original grid-based width calculation
  const h = height - 1
  const centerY = Math.floor(h / 2)
  const startY = centerY - Math.floor((lines.length - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const cells = toCells(line)
    const textX = Math.floor(w / 2) - Math.ceil(cells.length / 2) + 1
    for (let j = 0; j < cells.length; j++) {
      const x = textX + j
      const y = startY + i
      if (x >= 0 && x < canvas.length && y >= 0 && y < canvas[0]!.length) {
        canvas[x]![y] = cells[j]!
      }
    }
  }

  return canvas
}


export function getBoxAttachmentPoint(
  dir: Direction,
  dimensions: ShapeDimensions,
  baseCoord: DrawingCoord
): DrawingCoord {
  const { width, height } = dimensions
  const centerX = baseCoord.x + Math.floor(width / 2)
  const centerY = baseCoord.y + Math.floor(height / 2)

  if (dirEquals(dir, Up)) return { x: centerX, y: baseCoord.y }
  if (dirEquals(dir, Down)) return { x: centerX, y: baseCoord.y + height - 1 }
  if (dirEquals(dir, Left)) return { x: baseCoord.x, y: centerY }
  if (dirEquals(dir, Right)) return { x: baseCoord.x + width - 1, y: centerY }
  if (dirEquals(dir, UpperLeft)) return { x: baseCoord.x, y: baseCoord.y }
  if (dirEquals(dir, UpperRight)) return { x: baseCoord.x + width - 1, y: baseCoord.y }
  if (dirEquals(dir, LowerLeft)) return { x: baseCoord.x, y: baseCoord.y + height - 1 }
  if (dirEquals(dir, LowerRight)) return { x: baseCoord.x + width - 1, y: baseCoord.y + height - 1 }
  return { x: centerX, y: centerY }
}


export const rectangleRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label: string, dimensions: ShapeDimensions, options: ShapeRenderOptions): Canvas {
    const corners = getCorners('rectangle', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}
