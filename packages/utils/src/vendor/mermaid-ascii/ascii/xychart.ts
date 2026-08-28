
import { parseXYChart } from '../xychart/parser'
import type { XYChart } from '../xychart/types'
import type { AsciiConfig, AsciiTheme, ColorMode, CharRole, Canvas, RoleCanvas } from './types'
import { colorizeText } from './ansi'
import { getSeriesColor, CHART_ACCENT_FALLBACK } from '../xychart/colors'
import { displayWidth, toCells, WIDE_PAD } from '../text-metrics'


const PLOT_WIDTH = 60
const PLOT_HEIGHT = 20

const UNI = {
  hLine: '─',
  vLine: '│',
  origin: '┼',
  yTick: '┤',
  xTick: '┬',
  bar: '█',
  grid: '·',
  cornerTL: '╭',  // top-left: down+right
  cornerTR: '╮',  // top-right: down+left
  cornerBL: '╰',  // bottom-left: up+right
  cornerBR: '╯',  // bottom-right: up+left
} as const

const ASC = {
  hLine: '-',
  vLine: '|',
  origin: '+',
  yTick: '+',
  xTick: '+',
  bar: '#',
  grid: '.',
  cornerTL: '+',
  cornerTR: '+',
  cornerBL: '+',
  cornerBR: '+',
} as const


type HexCanvas = (string | null)[][]

function getSeriesColors(total: number, theme: AsciiTheme): string[] {
  const accent = theme.accent ?? CHART_ACCENT_FALLBACK
  if (total <= 1) return [accent]
  return Array.from({ length: total }, (_, i) => getSeriesColor(i, accent, theme.bg))
}

function roleToHex(role: CharRole, theme: AsciiTheme): string {
  switch (role) {
    case 'text': return theme.fg
    case 'border': return theme.border
    case 'line': return theme.line
    case 'arrow': return theme.arrow
    case 'corner': return theme.corner ?? theme.line
    case 'junction': return theme.junction ?? theme.border
    default: return theme.fg
  }
}


export function renderXYChartAscii(
  text: string,
  config: AsciiConfig,
  colorMode: ColorMode,
  theme: AsciiTheme,
): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  const chart = parseXYChart(lines)
  const ch = config.useAscii ? ASC : UNI

  if (chart.horizontal) {
    return renderHorizontal(chart, ch, colorMode, theme)
  }
  return renderVertical(chart, ch, colorMode, theme)
}


function renderVertical(
  chart: XYChart,
  ch: typeof UNI | typeof ASC,
  colorMode: ColorMode,
  theme: AsciiTheme,
): string {
  const dataCount = getDataCount(chart)
  if (dataCount === 0) return ''

  const yRange = chart.yAxis.range!
  const yTicks = niceTickValues(yRange.min, yRange.max)
  const yLabels = yTicks.map(v => formatTickValue(v))
  const yGutter = Math.max(...yLabels.map(l => displayWidth(l))) + 1

  const plotW = Math.max(PLOT_WIDTH, dataCount * 6)
  const plotH = PLOT_HEIGHT
  const bandW = Math.floor(plotW / dataCount)
  const catLabels = getCategoryLabels(chart, dataCount)

  const hasTitle = !!chart.title
  const hasXTitle = !!chart.xAxis.title
  const hasLegend = chart.series.length > 1
  const titleRow = hasTitle ? 0 : -1
  const plotTop = (hasTitle ? 2 : 0) + (hasLegend ? 1 : 0)
  const plotLeft = yGutter + 1 // +1 for axis character
  const totalW = plotLeft + bandW * dataCount + 2
  const xAxisRow = plotTop + plotH
  const xLabelRow = xAxisRow + 1
  const xTitleRow = hasXTitle ? xLabelRow + 1 : -1
  const totalH = xLabelRow + 1 + (hasXTitle ? 1 : 0) + (hasLegend && !hasTitle ? 0 : 0)

  const canvas = createCanvas(totalW, totalH)
  const roles = createRoleCanvas(totalW, totalH)
  const hexColors = createHexCanvas(totalW, totalH)

  const seriesColors = getSeriesColors(chart.series.length, theme)

  const valueToRow = (v: number): number => {
    const t = (v - yRange.min) / (yRange.max - yRange.min || 1)
    return Math.round(t * (plotH - 1))
  }
  const bandCenter = (i: number): number => plotLeft + Math.floor(bandW * (i + 0.5))

  if (hasTitle && titleRow >= 0) {
    writeText(canvas, roles, titleRow, Math.floor(totalW / 2 - displayWidth(chart.title!) / 2), chart.title!, 'text')
  }

  if (hasLegend) {
    const legendRow = hasTitle ? 1 : 0
    drawLegend(canvas, roles, hexColors, chart, legendRow, totalW, ch, seriesColors)
  }

  for (let row = 0; row < plotH; row++) {
    const displayRow = plotTop + (plotH - 1 - row)
    set(canvas, roles, displayRow, plotLeft - 1, ch.vLine, 'border')
  }
  set(canvas, roles, xAxisRow, plotLeft - 1, ch.origin, 'border')

  for (const tick of yTicks) {
    const row = valueToRow(tick)
    if (row < 0 || row >= plotH) continue
    const displayRow = plotTop + (plotH - 1 - row)
    const label = formatTickValue(tick)
    set(canvas, roles, displayRow, plotLeft - 1, row === 0 ? ch.origin : ch.yTick, 'border')
    const labelStart = yGutter - displayWidth(label)
    writeText(canvas, roles, displayRow, Math.max(0, labelStart), label, 'text')
  }

  for (let c = plotLeft; c < plotLeft + bandW * dataCount; c++) {
    set(canvas, roles, xAxisRow, c, ch.hLine, 'border')
  }
  for (let i = 0; i < dataCount; i++) {
    const cx = bandCenter(i)
    set(canvas, roles, xAxisRow, cx, ch.xTick, 'border')
    const label = catLabels[i]!
    const labelStart = cx - Math.floor(displayWidth(label) / 2)
    writeText(canvas, roles, xLabelRow, Math.max(0, labelStart), label, 'text')
  }

  if (hasXTitle && xTitleRow >= 0) {
    const title = chart.xAxis.title!
    writeText(canvas, roles, xTitleRow, Math.floor(totalW / 2 - displayWidth(title) / 2), title, 'text')
  }

  for (const tick of yTicks) {
    const row = valueToRow(tick)
    if (row < 0 || row >= plotH) continue
    const displayRow = plotTop + (plotH - 1 - row)
    for (let c = plotLeft; c < plotLeft + bandW * dataCount; c++) {
      if (get(canvas, displayRow, c) === ' ') {
        set(canvas, roles, displayRow, c, ch.grid, 'line')
      }
    }
  }

  const barEntries: { data: number[]; globalIdx: number }[] = []
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === 'bar') barEntries.push({ data: chart.series[si]!.data, globalIdx: si })
  }

  if (barEntries.length > 0) {
    const barCount = barEntries.length
    const usable = Math.max(1, bandW - 2)
    const singleBarW = Math.max(1, Math.min(Math.floor(usable / barCount), 8))
    const groupW = singleBarW * barCount + (barCount - 1)
    const baseRow = valueToRow(Math.max(0, yRange.min))

    for (let bIdx = 0; bIdx < barEntries.length; bIdx++) {
      const entry = barEntries[bIdx]!
      const hexColor = seriesColors[entry.globalIdx]!
      for (let i = 0; i < entry.data.length; i++) {
        const cx = bandCenter(i)
        const groupLeft = cx - Math.floor(groupW / 2)
        const bx = groupLeft + bIdx * (singleBarW + 1)
        const valRow = valueToRow(entry.data[i]!)
        const fromRow = Math.min(baseRow, valRow)
        const toRow = Math.max(baseRow, valRow)

        for (let row = fromRow; row <= toRow; row++) {
          const displayRow = plotTop + (plotH - 1 - row)
          for (let c = bx; c < bx + singleBarW; c++) {
            set(canvas, roles, displayRow, c, ch.bar, 'arrow', hexColors, hexColor)
          }
        }
      }
    }
  }

  const lineEntries: { data: number[]; globalIdx: number }[] = []
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === 'line') lineEntries.push({ data: chart.series[si]!.data, globalIdx: si })
  }

  for (const entry of lineEntries) {
    if (entry.data.length === 0) continue
    const hexColor = seriesColors[entry.globalIdx]!
    drawStaircaseLine(canvas, roles, entry.data, bandCenter, valueToRow, plotTop, plotH, plotLeft, bandW * dataCount, ch, hexColors, hexColor)
  }

  return canvasToString(canvas, roles, hexColors, colorMode, theme)
}


function renderHorizontal(
  chart: XYChart,
  ch: typeof UNI | typeof ASC,
  colorMode: ColorMode,
  theme: AsciiTheme,
): string {
  const dataCount = getDataCount(chart)
  if (dataCount === 0) return ''

  const yRange = chart.yAxis.range!
  const valueTicks = niceTickValues(yRange.min, yRange.max)
  const catLabels = getCategoryLabels(chart, dataCount)
  const catGutter = Math.max(...catLabels.map(l => displayWidth(l))) + 1

  const plotW = Math.max(PLOT_WIDTH, 40)
  const bandH = Math.max(2, Math.floor(PLOT_HEIGHT / dataCount))
  const plotH = bandH * dataCount

  const hasTitle = !!chart.title
  const hasYTitle = !!chart.yAxis.title
  const hasLegend = chart.series.length > 1
  const plotTop = (hasTitle ? 2 : 0) + (hasLegend ? 1 : 0)
  const plotLeft = catGutter + 1
  const totalW = plotLeft + plotW + 2
  const totalH = plotTop + plotH + 2 + (hasYTitle ? 1 : 0)
  const xAxisRow = plotTop + plotH

  const canvas = createCanvas(totalW, totalH)
  const roles = createRoleCanvas(totalW, totalH)
  const hexColors = createHexCanvas(totalW, totalH)

  const seriesColors = getSeriesColors(chart.series.length, theme)

  const valueToCol = (v: number): number => {
    const t = (v - yRange.min) / (yRange.max - yRange.min || 1)
    return plotLeft + Math.round(t * (plotW - 1))
  }
  const bandMid = (i: number): number => plotTop + Math.floor(bandH * (i + 0.5))

  if (hasTitle) {
    writeText(canvas, roles, 0, Math.floor(totalW / 2 - displayWidth(chart.title!) / 2), chart.title!, 'text')
  }

  if (hasLegend) {
    const legendRow = hasTitle ? 1 : 0
    drawLegend(canvas, roles, hexColors, chart, legendRow, totalW, ch, seriesColors)
  }

  for (let r = plotTop; r < plotTop + plotH; r++) {
    set(canvas, roles, r, plotLeft - 1, ch.vLine, 'border')
  }
  set(canvas, roles, xAxisRow, plotLeft - 1, ch.origin, 'border')

  for (let i = 0; i < dataCount; i++) {
    const my = bandMid(i)
    const label = catLabels[i]!
    const labelStart = catGutter - displayWidth(label)
    writeText(canvas, roles, my, Math.max(0, labelStart), label, 'text')
  }

  for (let c = plotLeft; c < plotLeft + plotW; c++) {
    set(canvas, roles, xAxisRow, c, ch.hLine, 'border')
  }
  for (const tick of valueTicks) {
    const cx = valueToCol(tick)
    if (cx < plotLeft || cx >= plotLeft + plotW) continue
    set(canvas, roles, xAxisRow, cx, ch.xTick, 'border')
    const label = formatTickValue(tick)
    writeText(canvas, roles, xAxisRow + 1, cx - Math.floor(displayWidth(label) / 2), label, 'text')
  }

  if (hasYTitle) {
    const title = chart.yAxis.title!
    writeText(canvas, roles, totalH - 1, Math.floor(totalW / 2 - displayWidth(title) / 2), title, 'text')
  }

  for (const tick of valueTicks) {
    const cx = valueToCol(tick)
    if (cx < plotLeft || cx >= plotLeft + plotW) continue
    for (let r = plotTop; r < plotTop + plotH; r++) {
      if (get(canvas, r, cx) === ' ') {
        set(canvas, roles, r, cx, ch.grid, 'line')
      }
    }
  }

  const barEntries: { data: number[]; globalIdx: number }[] = []
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === 'bar') barEntries.push({ data: chart.series[si]!.data, globalIdx: si })
  }

  if (barEntries.length > 0) {
    const barCount = barEntries.length
    const singleBarH = 1
    const groupH = singleBarH * barCount + (barCount - 1)
    const baseCol = valueToCol(Math.max(0, yRange.min))

    for (let bIdx = 0; bIdx < barEntries.length; bIdx++) {
      const entry = barEntries[bIdx]!
      const hexColor = seriesColors[entry.globalIdx]!
      for (let i = 0; i < entry.data.length; i++) {
        const my = bandMid(i)
        const groupTop = my - Math.floor(groupH / 2)
        const by = groupTop + bIdx * (singleBarH + 1)
        const valCol = valueToCol(entry.data[i]!)
        const fromCol = Math.min(baseCol, valCol)
        const toCol = Math.max(baseCol, valCol)

        for (let r = by; r < by + singleBarH; r++) {
          for (let c = fromCol; c <= toCol; c++) {
            set(canvas, roles, r, c, ch.bar, 'arrow', hexColors, hexColor)
          }
        }
      }
    }
  }

  const lineEntries: { data: number[]; globalIdx: number }[] = []
  for (let si = 0; si < chart.series.length; si++) {
    if (chart.series[si]!.type === 'line') lineEntries.push({ data: chart.series[si]!.data, globalIdx: si })
  }

  for (const entry of lineEntries) {
    if (entry.data.length === 0) continue
    const hexColor = seriesColors[entry.globalIdx]!
    drawHorizontalStaircaseLine(canvas, roles, entry.data, bandMid, valueToCol, plotTop, plotH, plotLeft, plotW, ch, hexColors, hexColor)
  }

  return canvasToString(canvas, roles, hexColors, colorMode, theme)
}


function drawStaircaseLine(
  canvas: Canvas,
  roles: RoleCanvas,
  data: number[],
  bandCenter: (i: number) => number,
  valueToRow: (v: number) => number,
  plotTop: number,
  plotH: number,
  plotLeft: number,
  plotTotalW: number,
  ch: typeof UNI | typeof ASC,
  hexCanvas?: HexCanvas,
  hexColor?: string | null,
): void {
  if (data.length === 0) return

  const points = data.map((v, i) => ({
    col: bandCenter(i),
    row: valueToRow(v),
  }))

  const drawAt = (col: number, row: number, char: string) => {
    const displayRow = plotTop + (plotH - 1 - row)
    if (displayRow >= 0 && col >= plotLeft && col < plotLeft + plotTotalW) {
      set(canvas, roles, displayRow, col, char, 'arrow', hexCanvas, hexColor)
    }
  }

  if (points.length === 1) {
    drawAt(points[0]!.col, points[0]!.row, ch.hLine)
    return
  }

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!
    const p2 = points[i + 1]!

    if (p1.row === p2.row) {
      for (let c = p1.col; c <= p2.col; c++) {
        drawAt(c, p1.row, ch.hLine)
      }
      continue
    }

    const midCol = Math.round((p1.col + p2.col) / 2)
    const goingUp = p2.row > p1.row

    for (let c = p1.col; c < midCol; c++) {
      drawAt(c, p1.row, ch.hLine)
    }

    if (goingUp) {
      drawAt(midCol, p1.row, ch.cornerBR) // ╯
    } else {
      drawAt(midCol, p1.row, ch.cornerTR) // ╮
    }

    const minRow = Math.min(p1.row, p2.row)
    const maxRow = Math.max(p1.row, p2.row)
    for (let row = minRow + 1; row < maxRow; row++) {
      drawAt(midCol, row, ch.vLine)
    }

    if (goingUp) {
      drawAt(midCol, p2.row, ch.cornerTL) // ╭
    } else {
      drawAt(midCol, p2.row, ch.cornerBL) // ╰
    }

    for (let c = midCol + 1; c <= p2.col; c++) {
      drawAt(c, p2.row, ch.hLine)
    }

    if (i === 0) {
      const leadStart = Math.max(plotLeft, p1.col - Math.floor((p2.col - p1.col) / 4))
      for (let c = leadStart; c < p1.col; c++) {
        drawAt(c, p1.row, ch.hLine)
      }
    }

    if (i === points.length - 2) {
      const trailEnd = Math.min(plotLeft + plotTotalW - 1, p2.col + Math.floor((p2.col - p1.col) / 4))
      for (let c = p2.col + 1; c <= trailEnd; c++) {
        drawAt(c, p2.row, ch.hLine)
      }
    }
  }
}


function drawHorizontalStaircaseLine(
  canvas: Canvas,
  roles: RoleCanvas,
  data: number[],
  bandMid: (i: number) => number,
  valueToCol: (v: number) => number,
  plotTop: number,
  plotH: number,
  plotLeft: number,
  plotW: number,
  ch: typeof UNI | typeof ASC,
  hexCanvas?: HexCanvas,
  hexColor?: string | null,
): void {
  if (data.length === 0) return

  const points = data.map((v, i) => ({
    row: bandMid(i),
    col: valueToCol(v),
  }))

  const drawAt = (row: number, col: number, char: string) => {
    if (row >= plotTop && row < plotTop + plotH && col >= plotLeft && col < plotLeft + plotW) {
      set(canvas, roles, row, col, char, 'arrow', hexCanvas, hexColor)
    }
  }

  if (points.length === 1) {
    drawAt(points[0]!.row, points[0]!.col, ch.vLine)
    return
  }

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!
    const p2 = points[i + 1]!

    if (p1.col === p2.col) {
      for (let r = p1.row; r <= p2.row; r++) {
        drawAt(r, p1.col, ch.vLine)
      }
      continue
    }

    const midRow = Math.round((p1.row + p2.row) / 2)
    const goingRight = p2.col > p1.col

    for (let r = p1.row; r < midRow; r++) {
      drawAt(r, p1.col, ch.vLine)
    }

    if (goingRight) {
      drawAt(midRow, p1.col, ch.cornerBL) // ╰
    } else {
      drawAt(midRow, p1.col, ch.cornerBR) // ╯
    }

    const minCol = Math.min(p1.col, p2.col)
    const maxCol = Math.max(p1.col, p2.col)
    for (let c = minCol + 1; c < maxCol; c++) {
      drawAt(midRow, c, ch.hLine)
    }

    if (goingRight) {
      drawAt(midRow, p2.col, ch.cornerTR) // ╮
    } else {
      drawAt(midRow, p2.col, ch.cornerTL) // ╭
    }

    for (let r = midRow + 1; r <= p2.row; r++) {
      drawAt(r, p2.col, ch.vLine)
    }
  }
}


function drawLegend(
  canvas: Canvas,
  roles: RoleCanvas,
  hexCanvas: HexCanvas,
  chart: XYChart,
  row: number,
  totalW: number,
  ch: typeof UNI | typeof ASC,
  seriesColors: string[],
): void {
  type LegendItem = { symbol: string; label: string; globalIdx: number }
  const items: LegendItem[] = []
  let barIdx = 0, lineIdx = 0
  for (let si = 0; si < chart.series.length; si++) {
    const s = chart.series[si]!
    if (s.type === 'bar') {
      items.push({ symbol: ch.bar, label: `Bar ${barIdx + 1}`, globalIdx: si })
      barIdx++
    } else {
      items.push({ symbol: ch.hLine, label: `Line ${lineIdx + 1}`, globalIdx: si })
      lineIdx++
    }
  }

  let totalLen = 0
  for (let i = 0; i < items.length; i++) {
    if (i > 0) totalLen += 2 // gap between items
    totalLen += 1 + 1 + displayWidth(items[i]!.label) // symbol + space + label
  }

  const startCol = Math.max(0, Math.floor(totalW / 2 - totalLen / 2))
  let col = startCol

  for (let i = 0; i < items.length; i++) {
    if (i > 0) col += 2 // gap
    const item = items[i]!
    set(canvas, roles, row, col, item.symbol, 'arrow', hexCanvas, seriesColors[item.globalIdx])
    col += 1
    col += 1
    writeText(canvas, roles, row, col, item.label, 'text')
    col += displayWidth(item.label)
  }
}


function createCanvas(width: number, height: number): Canvas {
  return Array.from({ length: width }, () => Array.from({ length: height }, () => ' '))
}

function createRoleCanvas(width: number, height: number): RoleCanvas {
  return Array.from({ length: width }, () => Array.from<CharRole | null>({ length: height }).fill(null))
}

function createHexCanvas(width: number, height: number): HexCanvas {
  return Array.from({ length: width }, () => Array.from<string | null>({ length: height }).fill(null))
}

function set(
  canvas: Canvas, roles: RoleCanvas, row: number, col: number,
  char: string, role: CharRole,
  hexCanvas?: HexCanvas, hex?: string | null,
): void {
  if (col >= 0 && col < canvas.length && row >= 0 && row < canvas[0]!.length) {
    canvas[col]![row] = char
    roles[col]![row] = role
    if (hexCanvas && hex) hexCanvas[col]![row] = hex
  }
}

function get(canvas: Canvas, row: number, col: number): string {
  if (col >= 0 && col < canvas.length && row >= 0 && row < canvas[0]!.length) {
    return canvas[col]![row]!
  }
  return ' '
}

function writeText(canvas: Canvas, roles: RoleCanvas, row: number, startCol: number, text: string, role: CharRole): void {
  const cells = toCells(text)
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!
    if (cell === WIDE_PAD) continue // written atomically with its lead
    const col = startCol + i
    const wide = cells[i + 1] === WIDE_PAD
    if (col < 0 || col + (wide ? 1 : 0) >= canvas.length) continue
    set(canvas, roles, row, col, cell, role)
    if (wide) set(canvas, roles, row, col + 1, WIDE_PAD, role)
  }
}


function canvasToString(
  canvas: Canvas,
  roles: RoleCanvas,
  hexCanvas: HexCanvas,
  colorMode: ColorMode,
  theme: AsciiTheme,
): string {
  if (canvas.length === 0) return ''
  const height = canvas[0]!.length
  const width = canvas.length
  const lines: string[] = []

  for (let row = 0; row < height; row++) {
    const chars: string[] = []
    const rowRoles: (CharRole | null)[] = []
    const rowHex: (string | null)[] = []
    for (let col = 0; col < width; col++) {
      const c = canvas[col]![row]!
      if (c === WIDE_PAD) continue
      chars.push(c)
      rowRoles.push(roles[col]![row]!)
      rowHex.push(hexCanvas[col]![row]!)
    }
    let end = chars.length - 1
    while (end >= 0 && chars[end] === ' ') end--
    if (end < 0) {
      lines.push('')
    } else {
      lines.push(colorizeRow(
        chars.slice(0, end + 1),
        rowRoles.slice(0, end + 1),
        rowHex.slice(0, end + 1),
        theme,
        colorMode,
      ))
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines.join('\n')
}

function colorizeRow(
  chars: string[],
  roles: (CharRole | null)[],
  hexOverrides: (string | null)[],
  theme: AsciiTheme,
  mode: ColorMode,
): string {
  if (mode === 'none') return chars.join('')

  let result = ''
  let currentColor: string | null = null
  let buffer = ''

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!

    if (char === ' ') {
      if (buffer.length > 0) {
        result += currentColor ? colorizeText(buffer, currentColor, mode) : buffer
        buffer = ''
        currentColor = null
      }
      result += ' '
      continue
    }

    const hexOvr = hexOverrides[i] ?? null
    const roleVal = roles[i] ?? null
    const color = hexOvr ?? (roleVal ? roleToHex(roleVal, theme) : null)

    if (color === currentColor) {
      buffer += char
    } else {
      if (buffer.length > 0) {
        result += currentColor ? colorizeText(buffer, currentColor, mode) : buffer
      }
      buffer = char
      currentColor = color
    }
  }

  if (buffer.length > 0) {
    result += currentColor ? colorizeText(buffer, currentColor, mode) : buffer
  }

  return result
}


function getDataCount(chart: XYChart): number {
  if (chart.xAxis.categories) return chart.xAxis.categories.length
  for (const s of chart.series) {
    if (s.data.length > 0) return s.data.length
  }
  return 0
}

function getCategoryLabels(chart: XYChart, count: number): string[] {
  if (chart.xAxis.categories) return chart.xAxis.categories
  if (chart.xAxis.range) {
    const { min, max } = chart.xAxis.range
    const step = count > 1 ? (max - min) / (count - 1) : 0
    return Array.from({ length: count }, (_, i) => formatTickValue(min + step * i))
  }
  return Array.from({ length: count }, (_, i) => String(i + 1))
}

function niceTickValues(min: number, max: number): number[] {
  const range = max - min
  if (range <= 0) return [min]

  const rawInterval = range / 6
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)))
  const residual = rawInterval / magnitude
  let niceInterval: number
  if (residual <= 1.5) niceInterval = magnitude
  else if (residual <= 3) niceInterval = 2 * magnitude
  else if (residual <= 7) niceInterval = 5 * magnitude
  else niceInterval = 10 * magnitude

  const start = Math.ceil(min / niceInterval) * niceInterval
  const ticks: number[] = []
  for (let v = start; v <= max + niceInterval * 0.001; v += niceInterval) {
    ticks.push(Math.round(v * 1e10) / 1e10)
  }
  return ticks
}

function formatTickValue(v: number): string {
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(Math.abs(v) < 10 ? 1 : 0)
}
