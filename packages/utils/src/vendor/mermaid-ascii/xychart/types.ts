
export interface XYChart {
  title?: string
  horizontal: boolean
  xAxis: XYAxis
  yAxis: XYAxis
  series: XYChartSeries[]
}

export interface XYAxis {
  title?: string
  categories?: string[]
  range?: { min: number; max: number }
}

export interface XYChartSeries {
  type: 'bar' | 'line'
  data: number[]
}


export interface LegendItem {
  label: string
  x: number
  y: number
  type: 'bar' | 'line'
  seriesIndex: number
  colorIndex: number
}

export interface PositionedTitle {
  text: string
  x: number
  y: number
}

export interface PositionedAxis {
  title?: { text: string; x: number; y: number; rotate?: number }
  ticks: AxisTick[]
  line: { x1: number; y1: number; x2: number; y2: number }
}

export interface AxisTick {
  label: string
  x: number
  y: number
  tx: number
  ty: number
  labelX: number
  labelY: number
  textAnchor: 'start' | 'middle' | 'end'
}

export interface PlotArea {
  x: number
  y: number
  width: number
  height: number
}

export interface PositionedBar {
  x: number
  y: number
  width: number
  height: number
  value: number
  label?: string
  seriesIndex: number
  colorIndex: number
}

export interface PositionedLine {
  points: Array<{ x: number; y: number; value: number; label?: string }>
  seriesIndex: number
  colorIndex: number
}

export interface GridLine {
  x1: number
  y1: number
  x2: number
  y2: number
}
