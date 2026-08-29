
import type {
  Canvas, DrawingCoord, GridCoord, Direction,
  AsciiGraph, AsciiNode, AsciiEdge, AsciiSubgraph, AsciiEdgeStyle, EdgeBundle,
} from './types'
import {
  Up, Down, Left, Right, UpperLeft, UpperRight, LowerLeft, LowerRight, Middle,
  drawingCoordEquals,
} from './types'
import { mkCanvas, copyCanvas, getCanvasSize, mergeCanvases, drawText, mkRoleCanvas, setRole, mergeRoleCanvases } from './canvas'
import type { RoleCanvas, CharRole } from './types'
import { determineDirection, dirEquals } from './edge-routing'
import { gridToDrawingCoord, lineToDrawing } from './grid'
import { splitLines } from './multiline-utils'
import { getCorners } from './shapes/corners'
import { getShapeAttachmentPoint } from './shapes/index'
import { displayWidth, toCells, WIDE_PAD } from '../text-metrics'


function drawNode(node: AsciiNode, graph: AsciiGraph): Canvas {
  return drawBoxWithGridDimensions(node, graph)
}

function drawBoxWithGridDimensions(node: AsciiNode, graph: AsciiGraph): Canvas {
  const gc = node.gridCoord!
  const useAscii = graph.config.useAscii

  let w = 0
  for (let i = 0; i < 2; i++) {
    w += graph.columnWidth.get(gc.x + i) ?? 0
  }
  let h = 0
  for (let i = 0; i < 2; i++) {
    h += graph.rowHeight.get(gc.y + i) ?? 0
  }

  const from: DrawingCoord = { x: 0, y: 0 }
  const to: DrawingCoord = { x: w, y: h }
  const box = mkCanvas(Math.max(from.x, to.x), Math.max(from.y, to.y))

  const corners = getCorners(node.shape, useAscii)

  const isDoubleBox = node.shape === 'state-end'
  const hChar = useAscii ? (isDoubleBox ? '=' : '-') : (isDoubleBox ? '═' : '─')
  const vChar = useAscii ? (isDoubleBox ? '‖' : '|') : (isDoubleBox ? '║' : '│')

  const doubleCorners = useAscii
    ? { tl: '#', tr: '#', bl: '#', br: '#' }
    : { tl: '╔', tr: '╗', bl: '╚', br: '╝' }
  const effectiveCorners = isDoubleBox ? doubleCorners : corners

  for (let x = from.x + 1; x < to.x; x++) box[x]![from.y] = hChar
  for (let x = from.x + 1; x < to.x; x++) box[x]![to.y] = hChar
  for (let y = from.y + 1; y < to.y; y++) box[from.x]![y] = vChar
  for (let y = from.y + 1; y < to.y; y++) box[to.x]![y] = vChar
  box[from.x]![from.y] = effectiveCorners.tl
  box[to.x]![from.y] = effectiveCorners.tr
  box[from.x]![to.y] = effectiveCorners.bl
  box[to.x]![to.y] = effectiveCorners.br

  const label = node.displayLabel
  const lines = splitLines(label)
  const textCenterY = from.y + Math.floor(h / 2)
  const startY = textCenterY - Math.floor((lines.length - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const cells = toCells(line)
    const textX = from.x + Math.floor(w / 2) - Math.ceil(cells.length / 2) + 1
    for (let j = 0; j < cells.length; j++) {
      if (textX + j >= 0 && textX + j < box.length && startY + i >= 0 && startY + i < box[0]!.length) {
        box[textX + j]![startY + i] = cells[j]!
      }
    }
  }

  return box
}

export function drawBox(node: AsciiNode, graph: AsciiGraph): Canvas {
  return drawNode(node, graph)
}


export function drawMultiBox(
  sections: string[][],
  useAscii: boolean,
  padding: number = 1,
): Canvas {
  let maxTextWidth = 0
  for (const section of sections) {
    for (const line of section) {
      maxTextWidth = Math.max(maxTextWidth, displayWidth(line))
    }
  }
  const innerWidth = maxTextWidth + 2 * padding
  const boxWidth = innerWidth + 2 // +2 for left/right border

  let totalLines = 0
  for (const section of sections) {
    totalLines += Math.max(section.length, 1) // at least 1 row per section
  }
  const numDividers = sections.length - 1
  const boxHeight = totalLines + numDividers + 2 // +2 for top/bottom border

  const hLine = useAscii ? '-' : '─'
  const vLine = useAscii ? '|' : '│'
  const tl = useAscii ? '+' : '┌'
  const tr = useAscii ? '+' : '┐'
  const bl = useAscii ? '+' : '└'
  const br = useAscii ? '+' : '┘'
  const divL = useAscii ? '+' : '├'
  const divR = useAscii ? '+' : '┤'

  const canvas = mkCanvas(boxWidth - 1, boxHeight - 1)

  canvas[0]![0] = tl
  for (let x = 1; x < boxWidth - 1; x++) canvas[x]![0] = hLine
  canvas[boxWidth - 1]![0] = tr

  canvas[0]![boxHeight - 1] = bl
  for (let x = 1; x < boxWidth - 1; x++) canvas[x]![boxHeight - 1] = hLine
  canvas[boxWidth - 1]![boxHeight - 1] = br

  for (let y = 1; y < boxHeight - 1; y++) {
    canvas[0]![y] = vLine
    canvas[boxWidth - 1]![y] = vLine
  }

  let row = 1 // current y position (starts after top border)
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!
    const lines = section.length > 0 ? section : ['']

    for (const line of lines) {
      const startX = 1 + padding
      const cells = toCells(line)
      for (let i = 0; i < cells.length; i++) {
        canvas[startX + i]![row] = cells[i]!
      }
      row++
    }

    if (s < sections.length - 1) {
      canvas[0]![row] = divL
      for (let x = 1; x < boxWidth - 1; x++) canvas[x]![row] = hLine
      canvas[boxWidth - 1]![row] = divR
      row++
    }
  }

  return canvas
}


const LINE_CHARS = {
  solid: {
    h: { unicode: '─', ascii: '-' },
    v: { unicode: '│', ascii: '|' },
  },
  dotted: {
    h: { unicode: '┄', ascii: '.' },
    v: { unicode: '┆', ascii: ':' },
  },
  thick: {
    h: { unicode: '━', ascii: '=' },
    v: { unicode: '┃', ascii: '‖' },
  },
} as const

function drawLine(
  canvas: Canvas,
  from: DrawingCoord,
  to: DrawingCoord,
  offsetFrom: number,
  offsetTo: number,
  useAscii: boolean,
  style: AsciiEdgeStyle = 'solid',
): DrawingCoord[] {
  const dir = determineDirection(from, to)
  const drawnCoords: DrawingCoord[] = []

  const chars = LINE_CHARS[style]
  const hChar = useAscii ? chars.h.ascii : chars.h.unicode
  const vChar = useAscii ? chars.v.ascii : chars.v.unicode

  if (dirEquals(dir, Up)) {
    for (let y = from.y - offsetFrom; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: from.x, y })
      canvas[from.x]![y] = vChar
    }
  } else if (dirEquals(dir, Down)) {
    for (let y = from.y + offsetFrom; y <= to.y + offsetTo; y++) {
      drawnCoords.push({ x: from.x, y })
      canvas[from.x]![y] = vChar
    }
  }
  else if (dirEquals(dir, Left)) {
    for (let x = from.x - offsetFrom; x >= to.x - offsetTo; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
  } else if (dirEquals(dir, Right)) {
    for (let x = from.x + offsetFrom; x <= to.x + offsetTo; x++) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
  }
  else if (dirEquals(dir, UpperLeft)) {
    for (let x = from.x - offsetFrom; x >= to.x; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
    for (let y = from.y - 1; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: to.x, y })
      canvas[to.x]![y] = vChar
    }
  }
  else if (dirEquals(dir, UpperRight)) {
    for (let x = from.x + offsetFrom; x <= to.x; x++) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
    for (let y = from.y - 1; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: to.x, y })
      canvas[to.x]![y] = vChar
    }
  }
  else if (dirEquals(dir, LowerLeft)) {
    for (let x = from.x - offsetFrom; x >= to.x; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
    for (let y = from.y + 1; y <= to.y + offsetTo; y++) {
      drawnCoords.push({ x: to.x, y })
      canvas[to.x]![y] = vChar
    }
  }
  else if (dirEquals(dir, LowerRight)) {
    const dx = to.x - from.x
    if (dx <= 1) {
      for (let y = from.y + offsetFrom; y <= to.y + offsetTo; y++) {
        drawnCoords.push({ x: from.x, y })
        canvas[from.x]![y] = vChar
      }
    } else {
      for (let x = from.x + offsetFrom; x <= to.x; x++) {
        drawnCoords.push({ x, y: from.y })
        canvas[x]![from.y] = hChar
      }
      for (let y = from.y + 1; y <= to.y + offsetTo; y++) {
        drawnCoords.push({ x: to.x, y })
        canvas[to.x]![y] = vChar
      }
    }
  }

  return drawnCoords
}


function drawArrow(
  graph: AsciiGraph,
  edge: AsciiEdge,
): [Canvas, Canvas, Canvas, Canvas, Canvas, Canvas] {
  if (edge.path.length === 0) {
    const empty = copyCanvas(graph.canvas)
    return [empty, empty, empty, empty, empty, empty]
  }

  const labelCanvas = drawArrowLabel(graph, edge)
  const [pathCanvas, linesDrawn, lineDirs] = drawPath(graph, edge.path, edge.style)
  const boxStartCanvas = drawBoxStart(graph, edge.path, linesDrawn[0]!, edge.from.shape)

  let arrowHeadEndCanvas: Canvas
  if (edge.hasArrowEnd) {
    arrowHeadEndCanvas = drawArrowHead(
      graph,
      linesDrawn[linesDrawn.length - 1]!,
      lineDirs[lineDirs.length - 1]!,
    )
  } else {
    arrowHeadEndCanvas = copyCanvas(graph.canvas)
  }

  let arrowHeadStartCanvas: Canvas
  if (edge.hasArrowStart && linesDrawn.length > 0) {
    const firstLine = linesDrawn[0]!
    const firstPoint = firstLine[0]!
    const startDir = reverseDirection(lineDirs[0]!)

    const arrowPos: DrawingCoord = { x: firstPoint.x, y: firstPoint.y }
    if (dirEquals(lineDirs[0]!, Right)) arrowPos.x = firstPoint.x - 1
    else if (dirEquals(lineDirs[0]!, Left)) arrowPos.x = firstPoint.x + 1
    else if (dirEquals(lineDirs[0]!, Down)) arrowPos.y = firstPoint.y - 1
    else if (dirEquals(lineDirs[0]!, Up)) arrowPos.y = firstPoint.y + 1

    const syntheticLine: DrawingCoord[] = [firstPoint, arrowPos]
    arrowHeadStartCanvas = drawArrowHead(graph, syntheticLine, startDir)
  } else {
    arrowHeadStartCanvas = copyCanvas(graph.canvas)
  }

  const cornersCanvas = drawCorners(graph, edge.path)

  return [pathCanvas, boxStartCanvas, arrowHeadEndCanvas, arrowHeadStartCanvas, cornersCanvas, labelCanvas]
}

function reverseDirection(dir: Direction): Direction {
  if (dirEquals(dir, Up)) return Down
  if (dirEquals(dir, Down)) return Up
  if (dirEquals(dir, Left)) return Right
  if (dirEquals(dir, Right)) return Left
  if (dirEquals(dir, UpperLeft)) return LowerRight
  if (dirEquals(dir, UpperRight)) return LowerLeft
  if (dirEquals(dir, LowerLeft)) return UpperRight
  if (dirEquals(dir, LowerRight)) return UpperLeft
  return Middle
}

function drawPath(
  graph: AsciiGraph,
  path: GridCoord[],
  style: AsciiEdgeStyle = 'solid',
): [Canvas, DrawingCoord[][], Direction[]] {
  const canvas = copyCanvas(graph.canvas)
  let previousCoord = path[0]!
  const linesDrawn: DrawingCoord[][] = []
  const lineDirs: Direction[] = []

  for (let i = 1; i < path.length; i++) {
    const nextCoord = path[i]!
    const prevDC = gridToDrawingCoord(graph, previousCoord)
    const nextDC = gridToDrawingCoord(graph, nextCoord)

    if (drawingCoordEquals(prevDC, nextDC)) {
      previousCoord = nextCoord
      continue
    }

    const dir = determineDirection(previousCoord, nextCoord)
    const segment = drawLine(canvas, prevDC, nextDC, 1, -1, graph.config.useAscii, style)
    if (segment.length === 0) segment.push(prevDC)
    linesDrawn.push(segment)
    lineDirs.push(dir)
    previousCoord = nextCoord
  }

  return [canvas, linesDrawn, lineDirs]
}

function drawBoxStart(
  graph: AsciiGraph,
  path: GridCoord[],
  firstLine: DrawingCoord[],
  sourceShape: string,
): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (graph.config.useAscii) return canvas

  if (sourceShape === 'state-start' || sourceShape === 'state-end') {
    return canvas
  }

  const from = firstLine[0]!
  const dir = determineDirection(path[0]!, path[1]!)

  if (dirEquals(dir, Up)) canvas[from.x]![from.y + 1] = '┴'
  else if (dirEquals(dir, Down)) canvas[from.x]![from.y - 1] = '┬'
  else if (dirEquals(dir, Left)) canvas[from.x + 1]![from.y] = '┤'
  else if (dirEquals(dir, Right)) canvas[from.x - 1]![from.y] = '├'

  return canvas
}

function drawArrowHead(
  graph: AsciiGraph,
  lastLine: DrawingCoord[],
  fallbackDir: Direction,
): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (lastLine.length === 0) return canvas

  const from = lastLine[0]!
  const lastPos = lastLine[lastLine.length - 1]!
  let dir = determineDirection(from, lastPos)
  if (lastLine.length === 1 || dirEquals(dir, Middle)) dir = fallbackDir

  let char: string

  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else if (dirEquals(dir, UpperRight)) char = '◥'
    else if (dirEquals(dir, UpperLeft)) char = '◤'
    else if (dirEquals(dir, LowerRight)) char = '◢'
    else if (dirEquals(dir, LowerLeft)) char = '◣'
    else {
      if (dirEquals(fallbackDir, Up)) char = '▲'
      else if (dirEquals(fallbackDir, Down)) char = '▼'
      else if (dirEquals(fallbackDir, Left)) char = '◄'
      else if (dirEquals(fallbackDir, Right)) char = '►'
      else if (dirEquals(fallbackDir, UpperRight)) char = '◥'
      else if (dirEquals(fallbackDir, UpperLeft)) char = '◤'
      else if (dirEquals(fallbackDir, LowerRight)) char = '◢'
      else if (dirEquals(fallbackDir, LowerLeft)) char = '◣'
      else char = '●'
    }
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else {
      if (dirEquals(fallbackDir, Up)) char = '^'
      else if (dirEquals(fallbackDir, Down)) char = 'v'
      else if (dirEquals(fallbackDir, Left)) char = '<'
      else if (dirEquals(fallbackDir, Right)) char = '>'
      else char = '*'
    }
  }

  canvas[lastPos.x]![lastPos.y] = char
  return canvas
}

function drawCorners(graph: AsciiGraph, path: GridCoord[]): Canvas {
  const canvas = copyCanvas(graph.canvas)

  for (let idx = 1; idx < path.length - 1; idx++) {
    const coord = path[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(path[idx - 1]!, coord)
    const nextDir = determineDirection(coord, path[idx + 1]!)

    let corner: string
    if (!graph.config.useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    canvas[dc.x]![dc.y] = corner
  }

  return canvas
}

function drawArrowLabel(graph: AsciiGraph, edge: AsciiEdge): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (edge.text.length === 0) return canvas

  const drawingLine = lineToDrawing(graph, edge.labelLine)

  let isUpwardEdge: boolean | undefined
  if (edge.path.length >= 2) {
    const startY = edge.path[0]!.y
    const endY = edge.path[edge.path.length - 1]!.y
    if (endY < startY) {
      isUpwardEdge = true
    } else if (endY > startY) {
      isUpwardEdge = false
    }
  }

  drawTextOnLine(canvas, drawingLine, edge.text, isUpwardEdge)
  return canvas
}

function drawTextOnLine(canvas: Canvas, line: DrawingCoord[], label: string, isUpwardEdge?: boolean): void {
  if (line.length < 2) return
  const minX = Math.min(line[0]!.x, line[1]!.x)
  const maxX = Math.max(line[0]!.x, line[1]!.x)
  const minY = Math.min(line[0]!.y, line[1]!.y)
  const maxY = Math.max(line[0]!.y, line[1]!.y)
  const middleX = minX + Math.floor((maxX - minX) / 2)
  let middleY = minY + Math.floor((maxY - minY) / 2)

  if (isUpwardEdge !== undefined && minX === maxX) {
    const segmentHeight = maxY - minY
    const offset = Math.max(1, Math.floor(segmentHeight / 4))
    if (isUpwardEdge) {
      middleY = middleY + offset
    } else {
      middleY = middleY - offset
    }
  }

  const lines = splitLines(label)
  const startY = middleY - Math.floor((lines.length - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!
    const startX = middleX - Math.floor(displayWidth(lineText) / 2)
    drawText(canvas, { x: startX, y: startY + i }, lineText)
  }
}


function getNodeAttachmentPoint(
  graph: AsciiGraph,
  node: AsciiNode,
  dir: Direction,
): DrawingCoord {
  const gc = node.gridCoord!

  let w = 0
  for (let i = 0; i < 2; i++) {
    w += graph.columnWidth.get(gc.x + i) ?? 0
  }
  let h = 0
  for (let i = 0; i < 2; i++) {
    h += graph.rowHeight.get(gc.y + i) ?? 0
  }

  const gridDimensions = {
    width: w + 1,
    height: h + 1,
    labelArea: { x: 0, y: 0, width: 0, height: 0 },
    gridColumns: [0, 0, 0] as [number, number, number],
    gridRows: [0, 0, 0] as [number, number, number],
  }

  const baseCoord = node.drawingCoord!
  return getShapeAttachmentPoint(node.shape, dir, gridDimensions, baseCoord)
}


function drawBundledEdgeSegment(
  graph: AsciiGraph,
  edge: AsciiEdge,
  bundle: EdgeBundle,
): [Canvas, Canvas, Canvas, Canvas, Canvas, Canvas] {
  const empty = copyCanvas(graph.canvas)

  if (!edge.pathToJunction || edge.pathToJunction.length === 0) {
    return [empty, empty, empty, empty, empty, empty]
  }

  const pathCanvas = copyCanvas(graph.canvas)
  const useAscii = graph.config.useAscii

  const drawingPath = edge.pathToJunction.map((gc, idx) => {
    if (bundle.type === 'fan-in' && idx === 0) {
      return getNodeAttachmentPoint(graph, edge.from, edge.startDir)
    }
    if (bundle.type === 'fan-out' && idx === edge.pathToJunction!.length - 1) {
      return getNodeAttachmentPoint(graph, edge.to, edge.endDir)
    }
    return gridToDrawingCoord(graph, gc)
  })

  for (let i = 1; i < drawingPath.length; i++) {
    const from = drawingPath[i - 1]!
    const to = drawingPath[i]!
    if (!drawingCoordEquals(from, to)) {
      drawLine(pathCanvas, from, to, 1, -1, useAscii, edge.style)
    }
  }

  const cornersCanvas = copyCanvas(graph.canvas)
  for (let idx = 1; idx < edge.pathToJunction.length - 1; idx++) {
    const coord = edge.pathToJunction[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(edge.pathToJunction[idx - 1]!, coord)
    const nextDir = determineDirection(coord, edge.pathToJunction[idx + 1]!)

    let corner: string
    if (!useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    cornersCanvas[dc.x]![dc.y] = corner
  }

  const boxStartCanvas = copyCanvas(graph.canvas)
  if (bundle.type === 'fan-in' && edge.pathToJunction.length >= 2) {
    const firstPoint = drawingPath[0]!
    const dir = determineDirection(edge.pathToJunction[0]!, edge.pathToJunction[1]!)

    if (!useAscii) {
      if (dirEquals(dir, Up)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '┴'
      else if (dirEquals(dir, Down)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '┬'
      else if (dirEquals(dir, Left)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '┤'
      else if (dirEquals(dir, Right)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '├'
    }
  }

  const labelCanvas = copyCanvas(graph.canvas)

  return [pathCanvas, boxStartCanvas, empty, empty, cornersCanvas, labelCanvas]
}

function drawBundleSharedPath(graph: AsciiGraph, bundle: EdgeBundle): [Canvas, Canvas] {
  const pathCanvas = copyCanvas(graph.canvas)
  const cornersCanvas = copyCanvas(graph.canvas)

  if (bundle.sharedPath.length < 2) {
    return [pathCanvas, cornersCanvas]
  }

  const useAscii = graph.config.useAscii
  const style = bundle.edges[0]?.style ?? 'solid'
  const graphDir = graph.config.graphDirection

  const drawingPath = bundle.sharedPath.map((gc, idx) => {
    if (bundle.type === 'fan-in' && idx === bundle.sharedPath.length - 1) {
      const entryDir = graphDir === 'TD' ? Up : Left
      return getNodeAttachmentPoint(graph, bundle.sharedNode, entryDir)
    }
    if (bundle.type === 'fan-out' && idx === 0) {
      const exitDir = graphDir === 'TD' ? Down : Right
      return getNodeAttachmentPoint(graph, bundle.sharedNode, exitDir)
    }
    return gridToDrawingCoord(graph, gc)
  })

  for (let i = 1; i < drawingPath.length; i++) {
    const from = drawingPath[i - 1]!
    const to = drawingPath[i]!
    if (!drawingCoordEquals(from, to)) {
      drawLine(pathCanvas, from, to, 1, -1, useAscii, style)
    }
  }

  for (let idx = 1; idx < bundle.sharedPath.length - 1; idx++) {
    const coord = bundle.sharedPath[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(bundle.sharedPath[idx - 1]!, coord)
    const nextDir = determineDirection(coord, bundle.sharedPath[idx + 1]!)

    let corner: string
    if (!useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    cornersCanvas[dc.x]![dc.y] = corner
  }

  return [pathCanvas, cornersCanvas]
}

function drawBundleArrowhead(graph: AsciiGraph, bundle: EdgeBundle): Canvas {
  const canvas = copyCanvas(graph.canvas)

  if (bundle.sharedPath.length < 2) return canvas

  const lastIdx = bundle.sharedPath.length - 1
  const secondLast = bundle.sharedPath[lastIdx - 1]!
  const last = bundle.sharedPath[lastIdx]!
  const dir = determineDirection(secondLast, last)

  const graphDir = graph.config.graphDirection
  const entryDir = graphDir === 'TD' ? Up : Left
  const dc = getNodeAttachmentPoint(graph, bundle.sharedNode, entryDir)
  if (graphDir === 'TD') dc.y -= 1
  else dc.x -= 1

  let char: string
  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else char = '▼'  // default
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else char = 'v'  // default
  }

  canvas[dc.x]![dc.y] = char
  return canvas
}

function drawBundledEdgeArrowhead(graph: AsciiGraph, edge: AsciiEdge): Canvas {
  const canvas = copyCanvas(graph.canvas)

  if (!edge.pathToJunction || edge.pathToJunction.length < 2) return canvas

  const lastIdx = edge.pathToJunction.length - 1
  const secondLast = edge.pathToJunction[lastIdx - 1]!
  const last = edge.pathToJunction[lastIdx]!
  const dir = determineDirection(secondLast, last)

  const graphDir = graph.config.graphDirection
  const entryDir = graphDir === 'TD' ? Up : Left
  const dc = getNodeAttachmentPoint(graph, edge.to, entryDir)
  if (graphDir === 'TD') dc.y -= 1
  else dc.x -= 1

  let char: string
  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else char = '▼'  // default
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else char = 'v'  // default
  }

  canvas[dc.x]![dc.y] = char
  return canvas
}

function drawJunctionCharacter(graph: AsciiGraph, bundle: EdgeBundle): Canvas {
  const canvas = copyCanvas(graph.canvas)

  if (!bundle.junctionPoint) return canvas

  const dc = gridToDrawingCoord(graph, bundle.junctionPoint)
  const useAscii = graph.config.useAscii

  let hasUp = false
  let hasDown = false
  let hasLeft = false
  let hasRight = false

  if (bundle.sharedPath.length >= 2) {
    const junctionIdx = bundle.type === 'fan-in' ? 0 : bundle.sharedPath.length - 1
    const adjacentIdx = bundle.type === 'fan-in' ? 1 : bundle.sharedPath.length - 2
    const sharedDir = determineDirection(
      bundle.sharedPath[junctionIdx]!,
      bundle.sharedPath[adjacentIdx]!
    )
    if (dirEquals(sharedDir, Down)) hasDown = true
    else if (dirEquals(sharedDir, Up)) hasUp = true
    else if (dirEquals(sharedDir, Right)) hasRight = true
    else if (dirEquals(sharedDir, Left)) hasLeft = true
  }

  for (const edge of bundle.edges) {
    if (edge.pathToJunction && edge.pathToJunction.length >= 2) {
      const junctionIdx = bundle.type === 'fan-in'
        ? edge.pathToJunction.length - 1
        : 0
      const adjacentIdx = bundle.type === 'fan-in'
        ? edge.pathToJunction.length - 2
        : 1

      const arrivalDir = determineDirection(
        edge.pathToJunction[adjacentIdx]!,
        edge.pathToJunction[junctionIdx]!
      )
      if (dirEquals(arrivalDir, Down)) hasUp = true    // arrived going down = came from up
      else if (dirEquals(arrivalDir, Up)) hasDown = true
      else if (dirEquals(arrivalDir, Right)) hasLeft = true
      else if (dirEquals(arrivalDir, Left)) hasRight = true
    }
  }

  let char: string
  if (!useAscii) {
    if (hasUp && hasDown && hasLeft && hasRight) {
      char = '┼'  // cross - all 4 directions
    } else if (hasDown && hasLeft && hasRight && !hasUp) {
      char = '┬'  // T pointing down
    } else if (hasUp && hasLeft && hasRight && !hasDown) {
      char = '┴'  // T pointing up
    } else if (hasUp && hasDown && hasRight && !hasLeft) {
      char = '├'  // T pointing right
    } else if (hasUp && hasDown && hasLeft && !hasRight) {
      char = '┤'  // T pointing left
    } else if (hasLeft && hasRight) {
      char = '─'  // horizontal only
    } else if (hasUp && hasDown) {
      char = '│'  // vertical only
    } else if (hasDown && hasRight) {
      char = '┌'  // corner
    } else if (hasDown && hasLeft) {
      char = '┐'
    } else if (hasUp && hasRight) {
      char = '└'
    } else if (hasUp && hasLeft) {
      char = '┘'
    } else {
      char = '┼'  // fallback
    }
  } else {
    char = '+'
  }

  canvas[dc.x]![dc.y] = char
  return canvas
}


function drawSubgraphBox(sg: AsciiSubgraph, graph: AsciiGraph): Canvas {
  const width = sg.maxX - sg.minX
  const height = sg.maxY - sg.minY
  if (width <= 0 || height <= 0) return mkCanvas(0, 0)

  const from: DrawingCoord = { x: 0, y: 0 }
  const to: DrawingCoord = { x: width, y: height }
  const canvas = mkCanvas(width, height)

  if (!graph.config.useAscii) {
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![from.y] = '─'
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![to.y] = '─'
    for (let y = from.y + 1; y < to.y; y++) canvas[from.x]![y] = '│'
    for (let y = from.y + 1; y < to.y; y++) canvas[to.x]![y] = '│'
    canvas[from.x]![from.y] = '┌'
    canvas[to.x]![from.y] = '┐'
    canvas[from.x]![to.y] = '└'
    canvas[to.x]![to.y] = '┘'
  } else {
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![from.y] = '-'
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![to.y] = '-'
    for (let y = from.y + 1; y < to.y; y++) canvas[from.x]![y] = '|'
    for (let y = from.y + 1; y < to.y; y++) canvas[to.x]![y] = '|'
    canvas[from.x]![from.y] = '+'
    canvas[to.x]![from.y] = '+'
    canvas[from.x]![to.y] = '+'
    canvas[to.x]![to.y] = '+'
  }

  return canvas
}

function drawSubgraphLabel(sg: AsciiSubgraph, graph: AsciiGraph): [Canvas, DrawingCoord] {
  const width = sg.maxX - sg.minX
  const height = sg.maxY - sg.minY
  if (width <= 0 || height <= 0) return [mkCanvas(0, 0), { x: 0, y: 0 }]

  const canvas = mkCanvas(width, height)

  const lines = splitLines(sg.name)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const labelY = 1 + i
    let labelX = Math.floor(width / 2) - Math.floor(displayWidth(line) / 2)
    if (labelX < 1) labelX = 1

    const cells = toCells(line)
    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j]!
      if (cell === WIDE_PAD) continue // written atomically with its lead
      const cx = labelX + j
      const wide = cells[j + 1] === WIDE_PAD
      if (cx + (wide ? 1 : 0) >= width || labelY >= height) continue
      canvas[cx]![labelY] = cell
      if (wide) canvas[cx + 1]![labelY] = WIDE_PAD
    }
  }

  return [canvas, { x: sg.minX, y: sg.minY }]
}


function sortSubgraphsByDepth(subgraphs: AsciiSubgraph[]): AsciiSubgraph[] {
  function getDepth(sg: AsciiSubgraph): number {
    return sg.parent === null ? 0 : 1 + getDepth(sg.parent)
  }
  const sorted = [...subgraphs]
  sorted.sort((a, b) => getDepth(a) - getDepth(b))
  return sorted
}


function fillRolesFromCanvas(
  roleCanvas: RoleCanvas,
  canvas: Canvas,
  offset: DrawingCoord,
  role: CharRole,
): void {
  for (let x = 0; x < canvas.length; x++) {
    for (let y = 0; y < (canvas[0]?.length ?? 0); y++) {
      const char = canvas[x]?.[y]
      if (char && char !== ' ') {
        const rx = x + offset.x
        const ry = y + offset.y
        if (rx >= 0 && ry >= 0) {
          setRole(roleCanvas, rx, ry, role)
        }
      }
    }
  }
}

function fillRolesFromCanvases(
  roleCanvas: RoleCanvas,
  canvases: Canvas[],
  offset: DrawingCoord,
  role: CharRole,
): void {
  for (const canvas of canvases) {
    fillRolesFromCanvas(roleCanvas, canvas, offset, role)
  }
}

function fillRolesForNodeBox(
  roleCanvas: RoleCanvas,
  canvas: Canvas,
  offset: DrawingCoord,
): void {
  const isBorderChar = (c: string) => /^[┌┐└┘├┤┬┴┼│─╭╮╰╯+\-|.':]$/.test(c)

  for (let x = 0; x < canvas.length; x++) {
    for (let y = 0; y < (canvas[0]?.length ?? 0); y++) {
      const char = canvas[x]?.[y]
      if (char && char !== ' ') {
        const rx = x + offset.x
        const ry = y + offset.y
        if (rx >= 0 && ry >= 0) {
          setRole(roleCanvas, rx, ry, isBorderChar(char) ? 'border' : 'text')
        }
      }
    }
  }
}

export function drawGraph(graph: AsciiGraph): Canvas {
  const useAscii = graph.config.useAscii
  const zero: DrawingCoord = { x: 0, y: 0 }

  const sortedSgs = sortSubgraphsByDepth(graph.subgraphs)
  for (const sg of sortedSgs) {
    const sgCanvas = drawSubgraphBox(sg, graph)
    const offset: DrawingCoord = { x: sg.minX, y: sg.minY }
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, sgCanvas)
    fillRolesFromCanvas(graph.roleCanvas, sgCanvas, offset, 'border')
  }

  for (const node of graph.nodes) {
    if (!node.drawn && node.drawingCoord && node.drawing) {
      graph.canvas = mergeCanvases(graph.canvas, node.drawingCoord, useAscii, node.drawing)
      fillRolesForNodeBox(graph.roleCanvas, node.drawing, node.drawingCoord)
      node.drawn = true
    }
  }

  const lineCanvases: Canvas[] = []
  const cornerCanvases: Canvas[] = []
  const arrowHeadEndCanvases: Canvas[] = []
  const arrowHeadStartCanvases: Canvas[] = []
  const boxStartCanvases: Canvas[] = []
  const labelCanvases: Canvas[] = []
  const junctionCanvases: Canvas[] = []

  const processedBundles = new Set<EdgeBundle>()

  for (const edge of graph.edges) {
    if (edge.bundle && edge.pathToJunction) {
      const bundle = edge.bundle

      const [pathC, boxStartC, , , cornersC, labelC] = drawBundledEdgeSegment(graph, edge, bundle)
      lineCanvases.push(pathC)
      cornerCanvases.push(cornersC)
      boxStartCanvases.push(boxStartC)
      labelCanvases.push(labelC)

      if (!processedBundles.has(bundle)) {
        processedBundles.add(bundle)

        const [sharedPathC, sharedCornersC] = drawBundleSharedPath(graph, bundle)
        lineCanvases.push(sharedPathC)
        cornerCanvases.push(sharedCornersC)

        if (bundle.type === 'fan-in') {
          const arrowHeadC = drawBundleArrowhead(graph, bundle)
          arrowHeadEndCanvases.push(arrowHeadC)
        }

        const junctionC = drawJunctionCharacter(graph, bundle)
        junctionCanvases.push(junctionC)
      }

      if (bundle.type === 'fan-out' && edge.hasArrowEnd) {
        const arrowHeadC = drawBundledEdgeArrowhead(graph, edge)
        arrowHeadEndCanvases.push(arrowHeadC)
      }
    } else {
      const [pathC, boxStartC, arrowHeadEndC, arrowHeadStartC, cornersC, labelC] = drawArrow(graph, edge)
      lineCanvases.push(pathC)
      cornerCanvases.push(cornersC)
      arrowHeadEndCanvases.push(arrowHeadEndC)
      arrowHeadStartCanvases.push(arrowHeadStartC)
      boxStartCanvases.push(boxStartC)
      labelCanvases.push(labelC)
    }
  }

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...lineCanvases)
  fillRolesFromCanvases(graph.roleCanvas, lineCanvases, zero, 'line')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...cornerCanvases)
  fillRolesFromCanvases(graph.roleCanvas, cornerCanvases, zero, 'corner')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...junctionCanvases)
  fillRolesFromCanvases(graph.roleCanvas, junctionCanvases, zero, 'junction')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...arrowHeadEndCanvases)
  fillRolesFromCanvases(graph.roleCanvas, arrowHeadEndCanvases, zero, 'arrow')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...boxStartCanvases)
  fillRolesFromCanvases(graph.roleCanvas, boxStartCanvases, zero, 'junction')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...arrowHeadStartCanvases)
  fillRolesFromCanvases(graph.roleCanvas, arrowHeadStartCanvases, zero, 'arrow')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...labelCanvases)
  fillRolesFromCanvases(graph.roleCanvas, labelCanvases, zero, 'text')

  for (const sg of graph.subgraphs) {
    if (sg.nodes.length === 0) continue
    const [labelCanvas, offset] = drawSubgraphLabel(sg, graph)
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, labelCanvas)
    fillRolesFromCanvas(graph.roleCanvas, labelCanvas, offset, 'text')
  }

  return graph.canvas
}
