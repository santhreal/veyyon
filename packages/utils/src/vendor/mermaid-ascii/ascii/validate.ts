
export const DIAGONAL_CHARS = {
  ascii: ['/', '\\'],
  unicode: ['\u2571', '\u2572'], // ╱ ╲
  all: ['/', '\\', '\u2571', '\u2572'],
} as const

export interface DiagonalPosition {
  line: number
  col: number
  char: string
}

export function hasDiagonalLines(asciiOutput: string): boolean {
  return DIAGONAL_CHARS.all.some((char) => asciiOutput.includes(char))
}

export function findDiagonalLines(asciiOutput: string): DiagonalPosition[] {
  const positions: DiagonalPosition[] = []
  const lines = asciiOutput.split('\n')

  const boxBorders = new Set(['│', '┤', '├', '║', '┃', '|'])

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]!

    const borderPositions: number[] = []
    for (let col = 0; col < line.length; col++) {
      if (boxBorders.has(line[col]!)) {
        borderPositions.push(col)
      }
    }

    for (let col = 0; col < line.length; col++) {
      const char = line[col]!
      if (DIAGONAL_CHARS.all.includes(char as '/' | '\\' | '╱' | '╲')) {
        let insideNode = false
        for (let i = 0; i < borderPositions.length - 1; i++) {
          const leftBorder = borderPositions[i]!
          const rightBorder = borderPositions[i + 1]!
          if (col > leftBorder && col < rightBorder) {
            insideNode = true
            break
          }
        }

        if (!insideNode) {
          positions.push({
            line: lineNum + 1, // 1-indexed for human readability
            col: col + 1,
            char,
          })
        }
      }
    }
  }

  return positions
}

export function assertNoDiagonals(asciiOutput: string, context?: string): void {
  if (!hasDiagonalLines(asciiOutput)) {
    return
  }

  const positions = findDiagonalLines(asciiOutput)
  const contextStr = context ? ` in "${context}"` : ''
  const positionStr = positions
    .map((p) => `  Line ${p.line}, Col ${p.col}: '${p.char}'`)
    .join('\n')

  throw new Error(
    `Diagonal lines detected${contextStr}. ` +
      `Edges must use orthogonal Manhattan routing (90° bends only).\n` +
      `Found ${positions.length} diagonal character(s):\n${positionStr}`
  )
}
