
import type { Canvas, DrawingCoord, RoleCanvas, CharRole, AsciiTheme, ColorMode } from './types'
import { colorizeLine, DEFAULT_ASCII_THEME } from './ansi'
import { displayWidth, toCells, WIDE_PAD } from '../text-metrics'

export function mkCanvas(x: number, y: number): Canvas {
  const canvas: Canvas = []
  for (let i = 0; i <= x; i++) {
    const col: string[] = []
    for (let j = 0; j <= y; j++) {
      col.push(' ')
    }
    canvas.push(col)
  }
  return canvas
}

export function copyCanvas(source: Canvas): Canvas {
  const [maxX, maxY] = getCanvasSize(source)
  return mkCanvas(maxX, maxY)
}


export function mkRoleCanvas(x: number, y: number): RoleCanvas {
  const roleCanvas: RoleCanvas = []
  for (let i = 0; i <= x; i++) {
    const col: (CharRole | null)[] = []
    for (let j = 0; j <= y; j++) {
      col.push(null)
    }
    roleCanvas.push(col)
  }
  return roleCanvas
}

export function copyRoleCanvas(source: RoleCanvas): RoleCanvas {
  const maxX = source.length - 1
  const maxY = (source[0]?.length ?? 1) - 1
  return mkRoleCanvas(maxX, maxY)
}

export function increaseRoleCanvasSize(roleCanvas: RoleCanvas, newX: number, newY: number): RoleCanvas {
  const currX = roleCanvas.length - 1
  const currY = (roleCanvas[0]?.length ?? 1) - 1
  const targetX = Math.max(newX, currX)
  const targetY = Math.max(newY, currY)
  const grown = mkRoleCanvas(targetX, targetY)
  for (let x = 0; x < grown.length; x++) {
    for (let y = 0; y < grown[0]!.length; y++) {
      if (x < roleCanvas.length && y < roleCanvas[0]!.length) {
        grown[x]![y] = roleCanvas[x]![y]!
      }
    }
  }
  roleCanvas.length = 0
  roleCanvas.push(...grown)
  return roleCanvas
}

export function setRole(roleCanvas: RoleCanvas, x: number, y: number, role: CharRole): void {
  if (x >= roleCanvas.length || y >= (roleCanvas[0]?.length ?? 0)) {
    increaseRoleCanvasSize(roleCanvas, x, y)
  }
  roleCanvas[x]![y] = role
}

export function mergeRoleCanvases(
  base: RoleCanvas,
  offset: DrawingCoord,
  ...overlays: RoleCanvas[]
): RoleCanvas {
  let maxX = base.length - 1
  let maxY = (base[0]?.length ?? 1) - 1

  for (const overlay of overlays) {
    const oX = overlay.length - 1
    const oY = (overlay[0]?.length ?? 1) - 1
    maxX = Math.max(maxX, oX + offset.x)
    maxY = Math.max(maxY, oY + offset.y)
  }

  const merged = mkRoleCanvas(maxX, maxY)

  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (x < base.length && y < base[0]!.length) {
        merged[x]![y] = base[x]![y]!
      }
    }
  }

  for (const overlay of overlays) {
    for (let x = 0; x < overlay.length; x++) {
      for (let y = 0; y < overlay[0]!.length; y++) {
        const role = overlay[x]?.[y]
        if (role !== null && role !== undefined) {
          const mx = x + offset.x
          const my = y + offset.y
          merged[mx]![my] = role
        }
      }
    }
  }

  return merged
}

export function getCanvasSize(canvas: Canvas): [number, number] {
  return [canvas.length - 1, (canvas[0]?.length ?? 1) - 1]
}

export function increaseSize(canvas: Canvas, newX: number, newY: number): Canvas {
  const [currX, currY] = getCanvasSize(canvas)
  const targetX = Math.max(newX, currX)
  const targetY = Math.max(newY, currY)
  const grown = mkCanvas(targetX, targetY)
  for (let x = 0; x < grown.length; x++) {
    for (let y = 0; y < grown[0]!.length; y++) {
      if (x < canvas.length && y < canvas[0]!.length) {
        grown[x]![y] = canvas[x]![y]!
      }
    }
  }
  canvas.length = 0
  canvas.push(...grown)
  return canvas
}


const JUNCTION_CHARS = new Set([
  '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼', '╴', '╵', '╶', '╷',
])

export function isJunctionChar(c: string): boolean {
  return JUNCTION_CHARS.has(c)
}

function isLabelChar(c: string): boolean {
  return c === WIDE_PAD || displayWidth(c) === 2 || /[\p{L}\p{N}]/u.test(c)
}

function writeCell(canvas: Canvas, x: number, y: number, c: string): void {
  const current = canvas[x]![y]!
  if (current === WIDE_PAD && x > 0 && c !== WIDE_PAD) {
    canvas[x - 1]![y] = ' '
  } else if (current !== WIDE_PAD && canvas[x + 1]?.[y] === WIDE_PAD && c !== current) {
    canvas[x + 1]![y] = ' '
  }
  canvas[x]![y] = c
}

const JUNCTION_MAP: Record<string, Record<string, string>> = {
  '─': { '│': '┼', '┌': '┬', '┐': '┬', '└': '┴', '┘': '┴', '├': '┼', '┤': '┼', '┬': '┬', '┴': '┴' },
  '│': { '─': '┼', '┌': '├', '┐': '┤', '└': '├', '┘': '┤', '├': '├', '┤': '┤', '┬': '┼', '┴': '┼' },
  '┌': { '─': '┬', '│': '├', '┐': '┬', '└': '├', '┘': '┼', '├': '├', '┤': '┼', '┬': '┬', '┴': '┼' },
  '┐': { '─': '┬', '│': '┤', '┌': '┬', '└': '┼', '┘': '┤', '├': '┼', '┤': '┤', '┬': '┬', '┴': '┼' },
  '└': { '─': '┴', '│': '├', '┌': '├', '┐': '┼', '┘': '┴', '├': '├', '┤': '┼', '┬': '┼', '┴': '┴' },
  '┘': { '─': '┴', '│': '┤', '┌': '┼', '┐': '┤', '└': '┴', '├': '┼', '┤': '┤', '┬': '┼', '┴': '┴' },
  '├': { '─': '┼', '│': '├', '┌': '├', '┐': '┼', '└': '├', '┘': '┼', '┤': '┼', '┬': '┼', '┴': '┼' },
  '┤': { '─': '┼', '│': '┤', '┌': '┼', '┐': '┤', '└': '┼', '┘': '┤', '├': '┼', '┬': '┼', '┴': '┼' },
  '┬': { '─': '┬', '│': '┼', '┌': '┬', '┐': '┬', '└': '┼', '┘': '┼', '├': '┼', '┤': '┼', '┴': '┼' },
  '┴': { '─': '┴', '│': '┼', '┌': '┼', '┐': '┼', '└': '┴', '┘': '┴', '├': '┼', '┤': '┼', '┬': '┼' },
}

export function mergeJunctions(c1: string, c2: string): string {
  return JUNCTION_MAP[c1]?.[c2] ?? c1
}


export function mergeCanvases(
  base: Canvas,
  offset: DrawingCoord,
  useAscii: boolean,
  ...overlays: Canvas[]
): Canvas {
  let [maxX, maxY] = getCanvasSize(base)
  for (const overlay of overlays) {
    const [oX, oY] = getCanvasSize(overlay)
    maxX = Math.max(maxX, oX + offset.x)
    maxY = Math.max(maxY, oY + offset.y)
  }

  const merged = mkCanvas(maxX, maxY)

  for (let x = 0; x <= maxX; x++) {
    for (let y = 0; y <= maxY; y++) {
      if (x < base.length && y < base[0]!.length) {
        merged[x]![y] = base[x]![y]!
      }
    }
  }

  for (const overlay of overlays) {
    for (let x = 0; x < overlay.length; x++) {
      for (let y = 0; y < overlay[0]!.length; y++) {
        const c = overlay[x]![y]!
        if (c === ' ' || c === WIDE_PAD) continue
        const mx = x + offset.x
        const my = y + offset.y
        const current = merged[mx]![my]!
        const isWide = overlay[x + 1]?.[y] === WIDE_PAD
        if (!useAscii && isJunctionChar(c) && isJunctionChar(current)) {
          merged[mx]![my] = mergeJunctions(current, c)
        } else if (isWide) {
          if (!isLabelChar(current) && !isLabelChar(merged[mx + 1]?.[my] ?? ' ')) {
            writeCell(merged, mx, my, c)
            writeCell(merged, mx + 1, my, WIDE_PAD)
          }
        } else if (isLabelChar(current) && isLabelChar(c)) {
        } else {
          writeCell(merged, mx, my, c)
        }
      }
    }
  }

  return merged
}


export interface CanvasToStringOptions {
  roleCanvas?: RoleCanvas
  colorMode?: ColorMode
  theme?: AsciiTheme
}

export function canvasToString(canvas: Canvas, options?: CanvasToStringOptions): string {
  const [maxX, maxY] = getCanvasSize(canvas)
  const lines: string[] = []

  const roleCanvas = options?.roleCanvas
  const colorMode = options?.colorMode ?? 'none'
  const theme = options?.theme ?? DEFAULT_ASCII_THEME

  for (let y = 0; y <= maxY; y++) {
    if (colorMode === 'none' || !roleCanvas) {
      let line = ''
      for (let x = 0; x <= maxX; x++) {
        const c = canvas[x]![y]!
        if (c !== WIDE_PAD) line += c
      }
      lines.push(line)
    } else {
      const chars: string[] = []
      const roles: (CharRole | null)[] = []
      for (let x = 0; x <= maxX; x++) {
        const c = canvas[x]![y]!
        if (c === WIDE_PAD) continue
        chars.push(c)
        roles.push(roleCanvas[x]?.[y] ?? null)
      }
      lines.push(colorizeLine(chars, roles, theme, colorMode))
    }
  }

  return lines.join('\n')
}


const VERTICAL_FLIP_MAP: Record<string, string> = {
  '▲': '▼', '▼': '▲',
  '◤': '◣', '◣': '◤',
  '◥': '◢', '◢': '◥',
  '^': 'v', 'v': '^',
  '┌': '└', '└': '┌',
  '┐': '┘', '┘': '┐',
  '┬': '┴', '┴': '┬',
  '╵': '╷', '╷': '╵',
}

export function flipCanvasVertically(canvas: Canvas): Canvas {
  for (const col of canvas) {
    col.reverse()
  }

  for (const col of canvas) {
    for (let y = 0; y < col.length; y++) {
      const flipped = VERTICAL_FLIP_MAP[col[y]!]
      if (flipped) col[y] = flipped
    }
  }

  return canvas
}

export function flipRoleCanvasVertically(roleCanvas: RoleCanvas): RoleCanvas {
  for (const col of roleCanvas) {
    col.reverse()
  }
  return roleCanvas
}

export function drawText(
  canvas: Canvas,
  start: DrawingCoord,
  text: string,
  forceOverwrite = false
): void {
  const cells = toCells(text)
  increaseSize(canvas, start.x + cells.length, start.y)
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    if (cell === WIDE_PAD) continue
    const x = start.x + i
    if (cells[i + 1] === WIDE_PAD) {
      const pairFree = canvas[x]![start.y] === ' ' && canvas[x + 1]![start.y] === ' '
      if (forceOverwrite || pairFree) {
        writeCell(canvas, x, start.y, cell)
        writeCell(canvas, x + 1, start.y, WIDE_PAD)
      }
    } else if (forceOverwrite || canvas[x]![start.y] === ' ') {
      writeCell(canvas, x, start.y, cell)
    }
  }
}

export function setCanvasSizeToGrid(
  canvas: Canvas,
  columnWidth: Map<number, number>,
  rowHeight: Map<number, number>,
): void {
  let maxX = 0
  let maxY = 0
  for (const w of columnWidth.values()) maxX += w
  for (const h of rowHeight.values()) maxY += h
  increaseSize(canvas, maxX - 1, maxY - 1)
}

export function setRoleCanvasSizeToGrid(
  roleCanvas: RoleCanvas,
  columnWidth: Map<number, number>,
  rowHeight: Map<number, number>,
): void {
  let maxX = 0
  let maxY = 0
  for (const w of columnWidth.values()) maxX += w
  for (const h of rowHeight.values()) maxY += h
  increaseRoleCanvasSize(roleCanvas, maxX - 1, maxY - 1)
}
