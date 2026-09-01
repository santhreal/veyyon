
import type { AsciiNodeShape, Canvas, DrawingCoord, Direction } from '../types'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions, ShapeRegistry } from './types'

import { rectangleRenderer } from './rectangle'
import { diamondRenderer } from './diamond'
import { circleRenderer } from './circle'
import { stateStartRenderer, stateEndRenderer } from './state'
import { roundedRenderer } from './rounded'
import { stadiumRenderer } from './stadium'
import { hexagonRenderer } from './hexagon'
import {
  subroutineRenderer,
  doublecircleRenderer,
  cylinderRenderer,
  asymmetricRenderer,
  trapezoidRenderer,
  trapezoidAltRenderer,
} from './special'

export type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions, ShapeRegistry }

export const shapeRegistry: ShapeRegistry = new Map<AsciiNodeShape, ShapeRenderer>([
  ['rectangle', rectangleRenderer],
  ['rounded', roundedRenderer],
  ['diamond', diamondRenderer],
  ['stadium', stadiumRenderer],
  ['circle', circleRenderer],

  ['subroutine', subroutineRenderer],
  ['doublecircle', doublecircleRenderer],
  ['hexagon', hexagonRenderer],

  ['cylinder', cylinderRenderer],
  ['asymmetric', asymmetricRenderer],
  ['trapezoid', trapezoidRenderer],
  ['trapezoid-alt', trapezoidAltRenderer],

  ['state-start', stateStartRenderer],
  ['state-end', stateEndRenderer],
])

function getShapeRenderer(shape: AsciiNodeShape): ShapeRenderer {
  return shapeRegistry.get(shape) ?? rectangleRenderer
}

function renderShape(
  shape: AsciiNodeShape,
  label: string,
  options: ShapeRenderOptions
): Canvas {
  const renderer = getShapeRenderer(shape)
  const dimensions = renderer.getDimensions(label, options)
  return renderer.render(label, dimensions, options)
}

export function getShapeDimensions(
  shape: AsciiNodeShape,
  label: string,
  options: ShapeRenderOptions
): ShapeDimensions {
  const renderer = getShapeRenderer(shape)
  return renderer.getDimensions(label, options)
}

export function getShapeAttachmentPoint(
  shape: AsciiNodeShape,
  dir: Direction,
  dimensions: ShapeDimensions,
  baseCoord: DrawingCoord
): DrawingCoord {
  const renderer = getShapeRenderer(shape)
  return renderer.getAttachmentPoint(dir, dimensions, baseCoord)
}
