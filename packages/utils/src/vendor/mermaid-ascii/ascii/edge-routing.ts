
import type { GridCoord, Direction, AsciiEdge, AsciiGraph } from './types'
import {
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
  gridCoordDirection,
} from './types'
import { getPath, mergePath } from './pathfinder'
import { getEffectiveDirection, getNodeSubgraph } from './grid'
import { displayWidth } from '../text-metrics'


export function getOpposite(d: Direction): Direction {
  if (d === Up) return Down
  if (d === Down) return Up
  if (d === Left) return Right
  if (d === Right) return Left
  if (d === UpperRight) return LowerLeft
  if (d === UpperLeft) return LowerRight
  if (d === LowerRight) return UpperLeft
  if (d === LowerLeft) return UpperRight
  return Middle
}

export function dirEquals(a: Direction, b: Direction): boolean {
  return a.x === b.x && a.y === b.y
}

export function determineDirection(from: { x: number; y: number }, to: { x: number; y: number }): Direction {
  if (from.x === to.x) {
    return from.y < to.y ? Down : Up
  } else if (from.y === to.y) {
    return from.x < to.x ? Right : Left
  } else if (from.x < to.x) {
    return from.y < to.y ? LowerRight : UpperRight
  } else {
    return from.y < to.y ? LowerLeft : UpperLeft
  }
}


function selfReferenceDirection(graphDirection: string): [Direction, Direction, Direction, Direction] {
  if (graphDirection === 'LR') return [Right, Down, Down, Right]
  return [Down, Right, Right, Down]
}

export function determineStartAndEndDir(
  edge: AsciiEdge,
  graphDirection: string,
): [Direction, Direction, Direction, Direction] {
  if (edge.from === edge.to) return selfReferenceDirection(graphDirection)

  const d = determineDirection(edge.from.gridCoord!, edge.to.gridCoord!)

  let preferredDir: Direction
  let preferredOppositeDir: Direction
  let alternativeDir: Direction
  let alternativeOppositeDir: Direction

  const isBackwards = graphDirection === 'LR'
    ? (dirEquals(d, Left) || dirEquals(d, UpperLeft) || dirEquals(d, LowerLeft))
    : (dirEquals(d, Up) || dirEquals(d, UpperLeft) || dirEquals(d, UpperRight))

  if (dirEquals(d, LowerRight)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Left
      alternativeDir = Right; alternativeOppositeDir = Up
    } else {
      preferredDir = Right; preferredOppositeDir = Up
      alternativeDir = Down; alternativeOppositeDir = Left
    }
  } else if (dirEquals(d, UpperRight)) {
    if (graphDirection === 'LR') {
      preferredDir = Up; preferredOppositeDir = Left
      alternativeDir = Right; alternativeOppositeDir = Down
    } else {
      preferredDir = Right; preferredOppositeDir = Down
      alternativeDir = Up; alternativeOppositeDir = Left
    }
  } else if (dirEquals(d, LowerLeft)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Up
    } else {
      preferredDir = Left; preferredOppositeDir = Up
      alternativeDir = Down; alternativeOppositeDir = Right
    }
  } else if (dirEquals(d, UpperLeft)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Down
    } else {
      preferredDir = Right; preferredOppositeDir = Right
      alternativeDir = Up; alternativeOppositeDir = Right
    }
  } else if (isBackwards) {
    if (graphDirection === 'LR' && dirEquals(d, Left)) {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Right
    } else if (graphDirection === 'TD' && dirEquals(d, Up)) {
      preferredDir = Right; preferredOppositeDir = Right
      alternativeDir = Up; alternativeOppositeDir = Down
    } else {
      preferredDir = d; preferredOppositeDir = getOpposite(d)
      alternativeDir = d; alternativeOppositeDir = getOpposite(d)
    }
  } else {
    preferredDir = d; preferredOppositeDir = getOpposite(d)
    alternativeDir = d; alternativeOppositeDir = getOpposite(d)
  }

  return [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir]
}


export function determinePath(graph: AsciiGraph, edge: AsciiEdge): void {
  const sourceSg = getNodeSubgraph(graph, edge.from)
  const targetSg = getNodeSubgraph(graph, edge.to)
  const effectiveDir = (sourceSg && sourceSg === targetSg && sourceSg.direction)
    ? sourceSg.direction
    : graph.config.graphDirection

  const [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir] =
    determineStartAndEndDir(edge, effectiveDir)

  const prefFrom = gridCoordDirection(edge.from.gridCoord!, preferredDir)
  const prefTo = gridCoordDirection(edge.to.gridCoord!, preferredOppositeDir)
  let preferredPath = getPath(graph.grid, prefFrom, prefTo)

  const altFrom = gridCoordDirection(edge.from.gridCoord!, alternativeDir)
  const altTo = gridCoordDirection(edge.to.gridCoord!, alternativeOppositeDir)
  let alternativePath = getPath(graph.grid, altFrom, altTo)

  if (preferredPath !== null && alternativePath !== null) {
    preferredPath = mergePath(preferredPath)
    alternativePath = mergePath(alternativePath)

    if (preferredPath.length <= alternativePath.length) {
      edge.startDir = preferredDir
      edge.endDir = preferredOppositeDir
      edge.path = preferredPath
    } else {
      edge.startDir = alternativeDir
      edge.endDir = alternativeOppositeDir
      edge.path = alternativePath
    }
    return
  }

  if (preferredPath !== null) {
    edge.startDir = preferredDir
    edge.endDir = preferredOppositeDir
    edge.path = mergePath(preferredPath)
    return
  }

  if (alternativePath !== null) {
    edge.startDir = alternativeDir
    edge.endDir = alternativeOppositeDir
    edge.path = mergePath(alternativePath)
    return
  }

  edge.startDir = preferredDir
  edge.endDir = preferredOppositeDir
  edge.path = [prefFrom, prefTo]
}

export function determineLabelLine(graph: AsciiGraph, edge: AsciiEdge): void {
  if (edge.text.length === 0) return

  const lenLabel = displayWidth(edge.text)
  const pathLen = edge.path.length
  const isVerticalFlow = graph.config.graphDirection === 'TD'

  const segments: {
    line: [GridCoord, GridCoord]
    width: number
    index: number
    isVertical: boolean
  }[] = []

  for (let i = 1; i < pathLen; i++) {
    const p1 = edge.path[i - 1]!
    const p2 = edge.path[i]!
    const line: [GridCoord, GridCoord] = [p1, p2]
    const width = calculateLineWidth(graph, line)
    const isVertical = p1.x === p2.x
    segments.push({ line, width, index: i, isVertical })
  }

  const suitableSegments = segments.filter(s => s.width >= lenLabel && s.index > 1)

  let largestLine: [GridCoord, GridCoord]

  if (suitableSegments.length > 0) {
    suitableSegments.sort((a, b) => b.index - a.index)
    largestLine = suitableSegments[0]!.line
  } else {
    const fallbackSegments = segments.filter(s => s.width >= lenLabel)
    if (fallbackSegments.length > 0) {
      fallbackSegments.sort((a, b) => b.index - a.index)
      largestLine = fallbackSegments[0]!.line
    } else {
      segments.sort((a, b) => b.width - a.width)
      largestLine = segments[0]?.line ?? [edge.path[0]!, edge.path[1]!]
    }
  }

  const minX = Math.min(largestLine[0].x, largestLine[1].x)
  const maxX = Math.max(largestLine[0].x, largestLine[1].x)
  const middleX = minX + Math.floor((maxX - minX) / 2)

  const current = graph.columnWidth.get(middleX) ?? 0
  graph.columnWidth.set(middleX, Math.max(current, lenLabel + 2))

  edge.labelLine = [largestLine[0], largestLine[1]]
}

function calculateLineWidth(graph: AsciiGraph, line: [GridCoord, GridCoord]): number {
  let total = 0
  const startX = Math.min(line[0].x, line[1].x)
  const endX = Math.max(line[0].x, line[1].x)
  for (let x = startX; x <= endX; x++) {
    total += graph.columnWidth.get(x) ?? 0
  }
  return total
}
