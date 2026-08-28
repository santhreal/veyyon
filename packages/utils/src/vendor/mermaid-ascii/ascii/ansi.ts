
import type { CharRole, AsciiTheme, ColorMode } from './types'

declare const document: unknown


export const DEFAULT_ASCII_THEME: AsciiTheme = {
  fg: '#27272a',      // zinc-800 — primary text
  border: '#a1a1aa',  // zinc-400 — node borders (12% mix)
  line: '#71717a',    // zinc-500 — edge lines (35% mix)
  arrow: '#52525b',   // zinc-600 — arrowheads (60% mix)
  corner: '#71717a',  // same as line
  junction: '#a1a1aa', // same as border
}


export function detectColorMode(): ColorMode {
  const proc = (globalThis as { process?: { stdout?: { isTTY?: boolean }, env?: Record<string, string | undefined> } }).process

  if (proc) {
    if (!proc.stdout?.isTTY) {
      return 'none'
    }

    const colorTerm = proc.env?.COLORTERM?.toLowerCase() ?? ''
    const term = proc.env?.TERM?.toLowerCase() ?? ''

    if (colorTerm === 'truecolor' || colorTerm === '24bit') {
      return 'truecolor'
    }

    if (term.includes('256color') || term.includes('256')) {
      return 'ansi256'
    }

    if (term && term !== 'dumb') {
      return 'ansi16'
    }

    return 'none'
  }

  if (typeof document !== 'undefined') {
    return 'html'
  }

  return 'none'
}


function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  if (h.length === 3) {
    return {
      r: parseInt(h[0]! + h[0]!, 16),
      g: parseInt(h[1]! + h[1]!, 16),
      b: parseInt(h[2]! + h[2]!, 16),
    }
  }
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}


const ESC = '\x1b['
const RESET = `${ESC}0m`

function truecolorFg(hex: string): string {
  const { r, g, b } = parseHex(hex)
  return `${ESC}38;2;${r};${g};${b}m`
}

function rgbTo256(r: number, g: number, b: number): number {
  const avg = (r + g + b) / 3
  const maxDiff = Math.max(Math.abs(r - avg), Math.abs(g - avg), Math.abs(b - avg))

  if (maxDiff < 10) {
    const gray = Math.round((avg / 255) * 23)
    return 232 + Math.min(23, Math.max(0, gray))
  }

  const toIndex = (v: number): number => {
    if (v < 48) return 0
    if (v < 115) return 1
    return Math.min(5, Math.floor((v - 35) / 40))
  }

  const ri = toIndex(r)
  const gi = toIndex(g)
  const bi = toIndex(b)

  return 16 + (36 * ri) + (6 * gi) + bi
}

function ansi256Fg(hex: string): string {
  const { r, g, b } = parseHex(hex)
  const index = rgbTo256(r, g, b)
  return `${ESC}38;5;${index}m`
}

function ansi16Fg(hex: string): string {
  const { r, g, b } = parseHex(hex)
  const luma = 0.299 * r + 0.587 * g + 0.114 * b

  const bright = luma > 100 ? 0 : 60 // 60 = bright variant offset

  let code: number
  if (r > 180 && g < 100 && b < 100) code = 31 // red
  else if (g > 180 && r < 100 && b < 100) code = 32 // green
  else if (r > 150 && g > 150 && b < 100) code = 33 // yellow
  else if (b > 180 && r < 100 && g < 100) code = 34 // blue
  else if (r > 150 && b > 150 && g < 100) code = 35 // magenta
  else if (g > 150 && b > 150 && r < 100) code = 36 // cyan
  else if (luma > 200) code = 37 // white
  else if (luma < 50) code = 30 // black
  else code = 37 // default to white for grays

  return `${ESC}${code + bright}m`
}


function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function htmlSpan(hex: string, text: string): string {
  return `<span style="color:${hex}">${escapeHtml(text)}</span>`
}


function getRoleColor(role: CharRole, theme: AsciiTheme): string {
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

export function getAnsiColor(role: CharRole, theme: AsciiTheme, mode: ColorMode): string {
  if (mode === 'none') return ''

  const hex = getRoleColor(role, theme)

  switch (mode) {
    case 'truecolor': return truecolorFg(hex)
    case 'ansi256': return ansi256Fg(hex)
    case 'ansi16': return ansi16Fg(hex)
    default: return ''
  }
}

export function getAnsiReset(mode: ColorMode): string {
  return mode === 'none' ? '' : RESET
}

export function colorizeChar(
  char: string,
  role: CharRole | null,
  theme: AsciiTheme,
  mode: ColorMode,
): string {
  if (mode === 'none' || role === null || char === ' ') {
    return char
  }

  const colorCode = getAnsiColor(role, theme, mode)
  return `${colorCode}${char}${RESET}`
}

export function colorizeLine(
  chars: string[],
  roles: (CharRole | null)[],
  theme: AsciiTheme,
  mode: ColorMode,
): string {
  if (mode === 'none') {
    return chars.join('')
  }

  if (mode === 'html') {
    return colorizeLineHtml(chars, roles, theme)
  }

  let result = ''
  let currentRole: CharRole | null = null
  let buffer = ''

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    const role = roles[i] ?? null

    if (char === ' ') {
      if (buffer.length > 0) {
        if (currentRole !== null) {
          result += getAnsiColor(currentRole, theme, mode) + buffer + RESET
        } else {
          result += buffer
        }
        buffer = ''
        currentRole = null
      }
      result += char
      continue
    }

    if (role === currentRole) {
      buffer += char
      continue
    }

    if (buffer.length > 0) {
      if (currentRole !== null) {
        result += getAnsiColor(currentRole, theme, mode) + buffer + RESET
      } else {
        result += buffer
      }
    }
    buffer = char
    currentRole = role
  }

  if (buffer.length > 0 && currentRole !== null) {
    result += getAnsiColor(currentRole, theme, mode) + buffer + RESET
  } else if (buffer.length > 0) {
    result += buffer
  }

  return result
}

function colorizeLineHtml(
  chars: string[],
  roles: (CharRole | null)[],
  theme: AsciiTheme,
): string {
  let result = ''
  let currentRole: CharRole | null = null
  let buffer = ''

  const flush = () => {
    if (buffer.length === 0) return
    if (currentRole !== null) {
      result += htmlSpan(getRoleColor(currentRole, theme), buffer)
    } else {
      result += escapeHtml(buffer)
    }
    buffer = ''
    currentRole = null
  }

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    const role = roles[i] ?? null

    if (char === ' ') {
      flush()
      result += ' '
      continue
    }

    if (role === currentRole) {
      buffer += char
      continue
    }

    flush()
    buffer = char
    currentRole = role
  }

  flush()
  return result
}

export function colorizeText(text: string, hex: string, mode: ColorMode): string {
  if (mode === 'none' || text.length === 0) return text
  if (mode === 'html') return htmlSpan(hex, text)
  let code: string
  switch (mode) {
    case 'truecolor': code = truecolorFg(hex); break
    case 'ansi256': code = ansi256Fg(hex); break
    case 'ansi16': code = ansi16Fg(hex); break
    default: return text
  }
  return `${code}${text}${RESET}`
}
