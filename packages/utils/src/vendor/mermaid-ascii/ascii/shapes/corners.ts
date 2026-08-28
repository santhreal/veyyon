
import type { AsciiNodeShape } from '../types'

export interface CornerChars {
  tl: string
  tr: string
  bl: string
  br: string
}

export interface ShapeCorners {
  unicode: CornerChars
  ascii: CornerChars
}

export const SHAPE_CORNERS: Record<AsciiNodeShape, ShapeCorners> = {
  rectangle: {
    unicode: { tl: '┌', tr: '┐', bl: '└', br: '┘' },
    ascii: { tl: '+', tr: '+', bl: '+', br: '+' },
  },
  rounded: {
    unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
    ascii: { tl: '.', tr: '.', bl: "'", br: "'" },
  },

  circle: {
    unicode: { tl: '◯', tr: '◯', bl: '◯', br: '◯' },
    ascii: { tl: 'o', tr: 'o', bl: 'o', br: 'o' },
  },
  doublecircle: {
    unicode: { tl: '◎', tr: '◎', bl: '◎', br: '◎' },
    ascii: { tl: '@', tr: '@', bl: '@', br: '@' },
  },

  diamond: {
    unicode: { tl: '◇', tr: '◇', bl: '◇', br: '◇' },
    ascii: { tl: '<', tr: '>', bl: '<', br: '>' },
  },

  hexagon: {
    unicode: { tl: '⌜', tr: '⌝', bl: '⌞', br: '⌟' },
    ascii: { tl: '*', tr: '*', bl: '*', br: '*' },
  },

  stadium: {
    unicode: { tl: '(', tr: ')', bl: '(', br: ')' },
    ascii: { tl: '(', tr: ')', bl: '(', br: ')' },
  },

  subroutine: {
    unicode: { tl: '╟', tr: '╢', bl: '╟', br: '╢' },
    ascii: { tl: '|', tr: '|', bl: '|', br: '|' },
  },

  cylinder: {
    unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
    ascii: { tl: '.', tr: '.', bl: "'", br: "'" },
  },

  asymmetric: {
    unicode: { tl: '▷', tr: '┐', bl: '▷', br: '┘' },
    ascii: { tl: '>', tr: '+', bl: '>', br: '+' },
  },

  trapezoid: {
    unicode: { tl: '/', tr: '\\', bl: '└', br: '┘' },
    ascii: { tl: '/', tr: '\\', bl: '+', br: '+' },
  },

  'trapezoid-alt': {
    unicode: { tl: '┌', tr: '┐', bl: '\\', br: '/' },
    ascii: { tl: '+', tr: '+', bl: '\\', br: '/' },
  },

  'state-start': {
    unicode: { tl: '●', tr: '●', bl: '●', br: '●' },
    ascii: { tl: '*', tr: '*', bl: '*', br: '*' },
  },
  'state-end': {
    unicode: { tl: '◉', tr: '◉', bl: '◉', br: '◉' },
    ascii: { tl: '@', tr: '@', bl: '@', br: '@' },
  },
}

export function getCorners(shape: AsciiNodeShape, useAscii: boolean): CornerChars {
  const corners = SHAPE_CORNERS[shape] ?? SHAPE_CORNERS.rectangle
  return useAscii ? corners.ascii : corners.unicode
}
