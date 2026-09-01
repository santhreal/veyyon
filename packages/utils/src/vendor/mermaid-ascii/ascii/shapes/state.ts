
import type { Canvas, DrawingCoord, Direction } from '../types'
import { Up, Down, Left, Right, UpperLeft, UpperRight, LowerLeft, LowerRight } from '../types'
import { mkCanvas } from '../canvas'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions } from './types'
import { dirEquals } from '../edge-routing'

export const stateStartRenderer: ShapeRenderer = {
  getDimensions(_label: string, _options: ShapeRenderOptions): ShapeDimensions {
    const width = 5
    const height = 3

    return {
      width,
      height,
      labelArea: { x: 2, y: 1, width: 1, height: 1 },
      gridColumns: [1, 3, 1],
      gridRows: [1, 1, 1],
    }
  },

  render(_label: string, dimensions: ShapeDimensions, options: ShapeRenderOptions): Canvas {
    const { width, height } = dimensions
    const canvas = mkCanvas(width - 1, height - 1)

    const centerX = Math.floor(width / 2)  // = 2

    if (!options.useAscii) {
      canvas[0]![0] = '╭'
      canvas[1]![0] = '─'
      canvas[2]![0] = '─'
      canvas[3]![0] = '─'
      canvas[4]![0] = '╮'

      canvas[0]![1] = '│'
      canvas[centerX]![1] = '●'
      canvas[4]![1] = '│'

      canvas[0]![2] = '╰'
      canvas[1]![2] = '─'
      canvas[2]![2] = '─'
      canvas[3]![2] = '─'
      canvas[4]![2] = '╯'
    } else {
      canvas[0]![0] = '.'
      canvas[1]![0] = '-'
      canvas[2]![0] = '-'
      canvas[3]![0] = '-'
      canvas[4]![0] = '.'

      canvas[0]![1] = '|'
      canvas[centerX]![1] = '*'
      canvas[4]![1] = '|'

      canvas[0]![2] = '\''
      canvas[1]![2] = '-'
      canvas[2]![2] = '-'
      canvas[3]![2] = '-'
      canvas[4]![2] = '\''
    }

    return canvas
  },

  getAttachmentPoint(
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
    return { x: centerX, y: centerY }
  },
}

export const stateEndRenderer: ShapeRenderer = {
  getDimensions(_label: string, _options: ShapeRenderOptions): ShapeDimensions {
    const width = 5
    const height = 3

    return {
      width,
      height,
      labelArea: { x: 2, y: 1, width: 1, height: 1 },
      gridColumns: [1, 3, 1],
      gridRows: [1, 1, 1],
    }
  },

  render(_label: string, dimensions: ShapeDimensions, options: ShapeRenderOptions): Canvas {
    const { width, height } = dimensions
    const canvas = mkCanvas(width - 1, height - 1)

    const centerX = Math.floor(width / 2)  // = 2

    if (!options.useAscii) {
      canvas[0]![0] = '╔'
      canvas[1]![0] = '═'
      canvas[2]![0] = '═'
      canvas[3]![0] = '═'
      canvas[4]![0] = '╗'

      canvas[0]![1] = '║'
      canvas[centerX]![1] = '◎'
      canvas[4]![1] = '║'

      canvas[0]![2] = '╚'
      canvas[1]![2] = '═'
      canvas[2]![2] = '═'
      canvas[3]![2] = '═'
      canvas[4]![2] = '╝'
    } else {
      canvas[0]![0] = '#'
      canvas[1]![0] = '='
      canvas[2]![0] = '='
      canvas[3]![0] = '='
      canvas[4]![0] = '#'

      canvas[0]![1] = '#'
      canvas[centerX]![1] = '*'
      canvas[4]![1] = '#'

      canvas[0]![2] = '#'
      canvas[1]![2] = '='
      canvas[2]![2] = '='
      canvas[3]![2] = '='
      canvas[4]![2] = '#'
    }

    return canvas
  },

  getAttachmentPoint(
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
    return { x: centerX, y: centerY }
  },
}
