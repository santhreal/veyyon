
import type { NodeShape } from '../types'

export type { NodeShape }

export type AsciiNodeShape = NodeShape

export interface GridCoord {
  x: number
  y: number
}

export interface DrawingCoord {
  x: number
  y: number
}

export interface Direction {
  readonly x: number
  readonly y: number
}

export const Up: Direction         = { x: 1, y: 0 }
export const Down: Direction       = { x: 1, y: 2 }
export const Left: Direction       = { x: 0, y: 1 }
export const Right: Direction      = { x: 2, y: 1 }
export const UpperRight: Direction = { x: 2, y: 0 }
export const UpperLeft: Direction  = { x: 0, y: 0 }
export const LowerRight: Direction = { x: 2, y: 2 }
export const LowerLeft: Direction  = { x: 0, y: 2 }
export const Middle: Direction     = { x: 1, y: 1 }

export const ALL_DIRECTIONS: readonly Direction[] = [
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
]

export type Canvas = string[][]

export interface AsciiNode {
  name: string
  displayLabel: string
  shape: AsciiNodeShape
  index: number
  gridCoord: GridCoord | null
  drawingCoord: DrawingCoord | null
  drawing: Canvas | null
  drawn: boolean
  styleClassName: string
  styleClass: AsciiStyleClass
}

export interface AsciiStyleClass {
  name: string
  styles: Record<string, string>
}

export type AsciiEdgeStyle = 'solid' | 'dotted' | 'thick'

export interface AsciiEdge {
  from: AsciiNode
  to: AsciiNode
  text: string
  path: GridCoord[]
  labelLine: GridCoord[]
  startDir: Direction
  endDir: Direction
  style: AsciiEdgeStyle
  hasArrowStart: boolean
  hasArrowEnd: boolean
  bundle?: EdgeBundle
  pathToJunction?: GridCoord[]
}

export interface AsciiSubgraph {
  name: string
  nodes: AsciiNode[]
  parent: AsciiSubgraph | null
  children: AsciiSubgraph[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  direction?: 'LR' | 'TD'
}

export interface AsciiConfig {
  useAscii: boolean
  paddingX: number
  paddingY: number
  boxBorderPadding: number
  graphDirection: 'LR' | 'TD'
}

export interface AsciiGraph {
  nodes: AsciiNode[]
  edges: AsciiEdge[]
  canvas: Canvas
  roleCanvas: RoleCanvas
  grid: Map<string, AsciiNode>
  columnWidth: Map<number, number>
  rowHeight: Map<number, number>
  subgraphs: AsciiSubgraph[]
  config: AsciiConfig
  offsetX: number
  offsetY: number
  bundles: EdgeBundle[]
}


export function gridCoordEquals(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y
}

export function drawingCoordEquals(a: DrawingCoord, b: DrawingCoord): boolean {
  return a.x === b.x && a.y === b.y
}

export function gridCoordDirection(c: GridCoord, dir: Direction): GridCoord {
  return { x: c.x + dir.x, y: c.y + dir.y }
}

export function gridKey(c: GridCoord): string {
  return `${c.x},${c.y}`
}

export const EMPTY_STYLE: AsciiStyleClass = { name: '', styles: {} }


export type CharRole =
  | 'text'      // Node labels, edge labels
  | 'border'    // Node box borders, subgraph borders
  | 'line'      // Edge lines (paths between nodes)
  | 'arrow'     // Arrowheads (▲▼◄► or ^v<>)
  | 'corner'    // Corner characters at path bends
  | 'junction'  // Junction characters (┬┴├┤ where edges meet boxes)

export type RoleCanvas = (CharRole | null)[][]

export interface AsciiTheme {
  fg: string
  border: string
  line: string
  arrow: string
  accent?: string
  bg?: string
  corner?: string
  junction?: string
}

export type ColorMode =
  | 'none'      // No colors (plain text)
  | 'ansi16'    // 16-color ANSI (basic terminals)
  | 'ansi256'   // 256-color ANSI (xterm)
  | 'truecolor' // 24-bit RGB (modern terminals)
  | 'html'      // HTML <span> tags with inline color styles (browsers)


export interface EdgeBundle {
  type: 'fan-in' | 'fan-out'
  edges: AsciiEdge[]
  sharedNode: AsciiNode
  otherNodes: AsciiNode[]
  junctionPoint: GridCoord | null
  sharedPath: GridCoord[]
  junctionDir: Direction
  sharedNodeDir: Direction
}
