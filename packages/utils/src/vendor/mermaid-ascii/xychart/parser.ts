import type { XYChart, XYAxis, XYChartSeries } from './types'


export function parseXYChart(lines: string[]): XYChart {
  const xAxis: XYAxis = {}
  const yAxis: XYAxis = {}
  const series: XYChartSeries[] = []
  let title: string | undefined
  let horizontal = false

  for (const line of lines) {
    if (/^xychart(-beta)?\b/i.test(line)) {
      if (/\bhorizontal\b/i.test(line)) horizontal = true
      continue
    }

    const titleMatch = line.match(/^title\s+"([^"]+)"/)
    if (titleMatch) {
      title = titleMatch[1]
      continue
    }

    const xCatMatch = line.match(/^x-axis\s+(?:"([^"]*)"\s*)?\[([^\]]+)\]/)
    if (xCatMatch) {
      if (xCatMatch[1]) xAxis.title = xCatMatch[1]
      xAxis.categories = xCatMatch[2]!.split(',').map(s => s.trim())
      continue
    }

    const xRangeMatch = line.match(/^x-axis\s+(?:"([^"]*)"\s+)?(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)/)
    if (xRangeMatch) {
      if (xRangeMatch[1]) xAxis.title = xRangeMatch[1]
      xAxis.range = { min: parseFloat(xRangeMatch[2]!), max: parseFloat(xRangeMatch[3]!) }
      continue
    }

    const yRangeMatch = line.match(/^y-axis\s+(?:"([^"]*)"\s+)?(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)/)
    if (yRangeMatch) {
      if (yRangeMatch[1]) yAxis.title = yRangeMatch[1]
      yAxis.range = { min: parseFloat(yRangeMatch[2]!), max: parseFloat(yRangeMatch[3]!) }
      continue
    }

    const yTitleOnly = line.match(/^y-axis\s+"([^"]+)"\s*$/)
    if (yTitleOnly) {
      yAxis.title = yTitleOnly[1]
      continue
    }

    const barMatch = line.match(/^bar\s+\[([^\]]+)\]/)
    if (barMatch) {
      series.push({ type: 'bar', data: parseNumericArray(barMatch[1]!) })
      continue
    }

    const lineMatch = line.match(/^line\s+\[([^\]]+)\]/)
    if (lineMatch) {
      series.push({ type: 'line', data: parseNumericArray(lineMatch[1]!) })
      continue
    }
  }

  if (!yAxis.range && series.length > 0) {
    const allValues = series.flatMap(s => s.data)
    let min = Math.min(...allValues)
    let max = Math.max(...allValues)
    const span = max - min || 1
    min = min - span * 0.1
    max = max + span * 0.1
    if (min > 0 && min < span * 0.5) min = 0
    yAxis.range = { min, max }
  }

  if (!yAxis.range) {
    yAxis.range = { min: 0, max: 100 }
  }

  return { title, horizontal, xAxis, yAxis, series }
}

function parseNumericArray(str: string): number[] {
  return str.split(',').map(s => parseFloat(s.trim()))
}
