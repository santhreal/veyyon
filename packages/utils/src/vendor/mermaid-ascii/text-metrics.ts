
export const WIDE_PAD = '\u0000'

const graphemeSegmenter = new Intl.Segmenter()

export function displayWidth(text: string): number {
  let ascii = true
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7e) {
      ascii = false
      break
    }
  }
  if (ascii) return text.length

  let width = 0
  for (const seg of graphemeSegmenter.segment(text)) {
    width += Bun.stringWidth(seg.segment) >= 2 ? 2 : 1
  }
  return width
}

export function toCells(text: string): string[] {
  const cells: string[] = []
  for (const seg of graphemeSegmenter.segment(text)) {
    cells.push(seg.segment)
    if (Bun.stringWidth(seg.segment) >= 2) {
      cells.push(WIDE_PAD)
    }
  }
  return cells
}
