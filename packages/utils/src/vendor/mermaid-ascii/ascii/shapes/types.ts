
import type { Canvas, DrawingCoord, Direction, AsciiNodeShape } from '../types'

export interface ShapeDimensions {
  width: number
  height: number
  labelArea: {
    x: number
    y: number
    width: number
    height: number
  }
  gridColumns: [number, number, number]
  gridRows: [number, number, number]
}

export interface ShapeRenderOptions {
  useAscii: boolean
  padding: number
}

export interface ShapeRenderer {
  getDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions

  render(
    label: string,
    dimensions: ShapeDimensions,
    options: ShapeRenderOptions
  ): Canvas

  getAttachmentPoint(
    dir: Direction,
    dimensions: ShapeDimensions,
    baseCoord: DrawingCoord
  ): DrawingCoord
}

export type ShapeRegistry = Map<AsciiNodeShape, ShapeRenderer>
