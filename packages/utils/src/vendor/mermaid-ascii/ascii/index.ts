
import { parseMermaid } from '../parser'
import { convertToAsciiGraph } from './converter'
import { createMapping } from './grid'
import { drawGraph } from './draw'
import { canvasToString, flipCanvasVertically, flipRoleCanvasVertically } from './canvas'
import { renderSequenceAscii } from './sequence'
import { renderClassAscii } from './class-diagram'
import { renderErAscii } from './er-diagram'
import { renderXYChartAscii } from './xychart'
import { detectColorMode, DEFAULT_ASCII_THEME } from './ansi'
import type { AsciiConfig, AsciiTheme, ColorMode } from './types'
import type { Direction } from '../types'

export type { AsciiTheme, ColorMode }
export { DEFAULT_ASCII_THEME, detectColorMode }

export interface AsciiRenderOptions {
  useAscii?: boolean
  paddingX?: number
  paddingY?: number
  boxBorderPadding?: number
  direction?: Direction
  colorMode?: ColorMode | 'auto'
  theme?: Partial<AsciiTheme>
}

function detectDiagramType(text: string): 'flowchart' | 'sequence' | 'class' | 'er' | 'xychart' {
  const firstLine = text.trim().split('\n')[0]?.trim().toLowerCase() ?? ''

  if (/^xychart(-beta)?\b/.test(firstLine)) return 'xychart'
  if (/^sequencediagram\s*$/.test(firstLine)) return 'sequence'
  if (/^classdiagram\s*$/.test(firstLine)) return 'class'
  if (/^erdiagram\s*$/.test(firstLine)) return 'er'

  return 'flowchart'
}

export function renderMermaidASCII(
  text: string,
  options: AsciiRenderOptions = {},
): string {
  const config: AsciiConfig = {
    useAscii: options.useAscii ?? false,
    paddingX: options.paddingX ?? 5,
    paddingY: options.paddingY ?? 5,
    boxBorderPadding: options.boxBorderPadding ?? 1,
    graphDirection: 'TD', // default, overridden for flowcharts below
  }

  const colorMode: ColorMode = options.colorMode === 'auto' || options.colorMode === undefined
    ? detectColorMode()
    : options.colorMode

  const theme: AsciiTheme = { ...DEFAULT_ASCII_THEME, ...options.theme }

  const diagramType = detectDiagramType(text)

  switch (diagramType) {
    case 'xychart':
      return renderXYChartAscii(text, config, colorMode, theme)

    case 'sequence':
      return renderSequenceAscii(text, config, colorMode, theme)

    case 'class':
      return renderClassAscii(text, config, colorMode, theme)

    case 'er':
      return renderErAscii(text, config, colorMode, theme)

    case 'flowchart':
    default: {
      const parsed = parseMermaid(text)

      if (options.direction) {
        parsed.direction = options.direction
      }

      if (parsed.direction === 'LR' || parsed.direction === 'RL') {
        config.graphDirection = 'LR'
      } else {
        config.graphDirection = 'TD'
      }

      const graph = convertToAsciiGraph(parsed, config)
      createMapping(graph)
      drawGraph(graph)

      if (parsed.direction === 'BT') {
        flipCanvasVertically(graph.canvas)
        flipRoleCanvasVertically(graph.roleCanvas)
      }

      return canvasToString(graph.canvas, {
        roleCanvas: graph.roleCanvas,
        colorMode,
        theme,
      })
    }
  }
}

export const renderMermaidAscii = renderMermaidASCII
