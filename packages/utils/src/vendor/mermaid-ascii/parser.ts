import type { MermaidGraph, MermaidNode, MermaidEdge, MermaidSubgraph, Direction, NodeShape, EdgeStyle } from './types'
import { normalizeBrTags } from './multiline-utils'


export function parseMermaid(text: string): MermaidGraph {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))

  if (lines.length === 0) {
    throw new Error('Empty mermaid diagram')
  }

  const header = lines[0]!

  if (/^stateDiagram(-v2)?\s*$/i.test(header)) {
    return parseStateDiagram(lines)
  }

  return parseFlowchart(lines)
}


function parseFlowchart(lines: string[]): MermaidGraph {
  const headerMatch = lines[0]!.match(/^(?:graph|flowchart)\s+(TD|TB|LR|BT|RL)\s*$/i)
  if (!headerMatch) {
    throw new Error(`Invalid mermaid header: "${lines[0]}". Expected "graph TD", "flowchart LR", "stateDiagram-v2", etc.`)
  }

  const direction = headerMatch[1]!.toUpperCase() as Direction

  const graph: MermaidGraph = {
    direction,
    nodes: new Map(),
    edges: [],
    subgraphs: [],
    classDefs: new Map(),
    classAssignments: new Map(),
    nodeStyles: new Map(),
    linkStyles: new Map(),
  }

  const subgraphStack: MermaidSubgraph[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    const classDefMatch = line.match(/^classDef\s+(\w+)\s+(.+)$/)
    if (classDefMatch) {
      const name = classDefMatch[1]!
      const propsStr = classDefMatch[2]!
      const props = parseStyleProps(propsStr)
      graph.classDefs.set(name, props)
      continue
    }

    const classAssignMatch = line.match(/^class\s+([\w,-]+)\s+(\w+)$/)
    if (classAssignMatch) {
      const nodeIds = classAssignMatch[1]!.split(',').map(s => s.trim())
      const className = classAssignMatch[2]!
      for (const id of nodeIds) {
        graph.classAssignments.set(id, className)
      }
      continue
    }

    const styleMatch = line.match(/^style\s+([\w,-]+)\s+(.+)$/)
    if (styleMatch) {
      const nodeIds = styleMatch[1]!.split(',').map(s => s.trim())
      const props = parseStyleProps(styleMatch[2]!)
      for (const id of nodeIds) {
        graph.nodeStyles.set(id, { ...graph.nodeStyles.get(id), ...props })
      }
      continue
    }

    const linkStyleMatch = line.match(/^linkStyle\s+(default|[\d,\s]+)\s+(.+)$/)
    if (linkStyleMatch) {
      const target = linkStyleMatch[1]!.trim()
      const props = parseStyleProps(linkStyleMatch[2]!)
      if (target === 'default') {
        graph.linkStyles.set('default', { ...graph.linkStyles.get('default'), ...props })
      } else {
        const indices = target.split(',').map(s => parseInt(s.trim(), 10))
        for (const idx of indices) {
          if (!isNaN(idx)) {
            graph.linkStyles.set(idx, { ...graph.linkStyles.get(idx), ...props })
          }
        }
      }
      continue
    }

    const dirMatch = line.match(/^direction\s+(TD|TB|LR|BT|RL)\s*$/i)
    if (dirMatch && subgraphStack.length > 0) {
      subgraphStack[subgraphStack.length - 1]!.direction = dirMatch[1]!.toUpperCase() as Direction
      continue
    }

    const subgraphMatch = line.match(/^subgraph\s+(.+)$/)
    if (subgraphMatch) {
      const rest = subgraphMatch[1]!.trim()
      const bracketMatch = rest.match(/^([\w-]+)\s*\[(.+)\]$/)
      let id: string
      let label: string
      if (bracketMatch) {
        id = bracketMatch[1]!
        label = normalizeBrTags(bracketMatch[2]!)
      } else {
        label = normalizeBrTags(rest)
        id = rest.replace(/\s+/g, '_').replace(/[^\w]/g, '')
      }
      const sg: MermaidSubgraph = { id, label, nodeIds: [], children: [] }
      subgraphStack.push(sg)
      continue
    }

    if (line === 'end') {
      const completed = subgraphStack.pop()
      if (completed) {
        if (subgraphStack.length > 0) {
          subgraphStack[subgraphStack.length - 1]!.children.push(completed)
        } else {
          graph.subgraphs.push(completed)
        }
      }
      continue
    }

    parseEdgeLine(line, graph, subgraphStack)
  }

  return graph
}


function parseStateDiagram(lines: string[]): MermaidGraph {
  const graph: MermaidGraph = {
    direction: 'TD',
    nodes: new Map(),
    edges: [],
    subgraphs: [],
    classDefs: new Map(),
    classAssignments: new Map(),
    nodeStyles: new Map(),
    linkStyles: new Map(),
  }

  const compositeStack: MermaidSubgraph[] = []
  const compositeStateIds = new Set<string>()
  let startCount = 0
  let endCount = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    const dirMatch = line.match(/^direction\s+(TD|TB|LR|BT|RL)\s*$/i)
    if (dirMatch) {
      if (compositeStack.length > 0) {
        compositeStack[compositeStack.length - 1]!.direction = dirMatch[1]!.toUpperCase() as Direction
      } else {
        graph.direction = dirMatch[1]!.toUpperCase() as Direction
      }
      continue
    }

    const linkStyleMatch = line.match(/^linkStyle\s+(default|[\d,\s]+)\s+(.+)$/)
    if (linkStyleMatch) {
      const target = linkStyleMatch[1]!.trim()
      const props = parseStyleProps(linkStyleMatch[2]!)
      if (target === 'default') {
        graph.linkStyles.set('default', { ...graph.linkStyles.get('default'), ...props })
      } else {
        const indices = target.split(',').map(s => parseInt(s.trim(), 10))
        for (const idx of indices) {
          if (!isNaN(idx)) {
            graph.linkStyles.set(idx, { ...graph.linkStyles.get(idx), ...props })
          }
        }
      }
      continue
    }

    const compositeMatch = line.match(/^state\s+(?:"([^"]+)"\s+as\s+)?([\w\p{L}]+)\s*\{$/u)
    if (compositeMatch) {
      const label = compositeMatch[1] ?? compositeMatch[2]!
      const id = compositeMatch[2]!
      const sg: MermaidSubgraph = { id, label, nodeIds: [], children: [] }
      compositeStack.push(sg)
      compositeStateIds.add(id)
      graph.nodes.delete(id)
      continue
    }

    if (line === '}') {
      const completed = compositeStack.pop()
      if (completed) {
        if (compositeStack.length > 0) {
          compositeStack[compositeStack.length - 1]!.children.push(completed)
        } else {
          graph.subgraphs.push(completed)
        }
      }
      continue
    }

    const stateAliasMatch = line.match(/^state\s+"([^"]+)"\s+as\s+([\w\p{L}]+)\s*$/u)
    if (stateAliasMatch) {
      const label = normalizeBrTags(stateAliasMatch[1]!)
      const id = stateAliasMatch[2]!
      registerStateNode(graph, compositeStack, { id, label, shape: 'rounded' })
      continue
    }

    const transitionMatch = line.match(/^(\[\*\]|[\w\p{L}-]+)\s*(-->)\s*(\[\*\]|[\w\p{L}-]+)(?:\s*:\s*(.+))?$/u)
    if (transitionMatch) {
      let sourceId = transitionMatch[1]!
      let targetId = transitionMatch[3]!
      const rawTransitionLabel = transitionMatch[4]?.trim()
      const edgeLabel = rawTransitionLabel ? normalizeBrTags(rawTransitionLabel) : undefined

      if (sourceId === '[*]') {
        startCount++
        sourceId = `_start${startCount > 1 ? startCount : ''}`
        registerStateNode(graph, compositeStack, { id: sourceId, label: '', shape: 'state-start' })
      } else if (!compositeStateIds.has(sourceId)) {
        ensureStateNode(graph, compositeStack, sourceId)
      }

      if (targetId === '[*]') {
        endCount++
        targetId = `_end${endCount > 1 ? endCount : ''}`
        registerStateNode(graph, compositeStack, { id: targetId, label: '', shape: 'state-end' })
      } else if (!compositeStateIds.has(targetId)) {
        ensureStateNode(graph, compositeStack, targetId)
      }

      graph.edges.push({
        source: sourceId,
        target: targetId,
        label: edgeLabel,
        style: 'solid',
        hasArrowStart: false,
        hasArrowEnd: true,
      })
      continue
    }

    const stateDescMatch = line.match(/^([\w\p{L}-]+)\s*:\s*(.+)$/u)
    if (stateDescMatch) {
      const id = stateDescMatch[1]!
      const label = normalizeBrTags(stateDescMatch[2]!.trim())
      registerStateNode(graph, compositeStack, { id, label, shape: 'rounded' })
      continue
    }
  }

  return graph
}

function registerStateNode(
  graph: MermaidGraph,
  compositeStack: MermaidSubgraph[],
  node: MermaidNode
): void {
  const isNew = !graph.nodes.has(node.id)
  if (isNew) {
    graph.nodes.set(node.id, node)
  }
  if (compositeStack.length > 0) {
    const current = compositeStack[compositeStack.length - 1]!
    if (!current.nodeIds.includes(node.id)) {
      current.nodeIds.push(node.id)
    }
  }
}

function ensureStateNode(
  graph: MermaidGraph,
  compositeStack: MermaidSubgraph[],
  id: string
): void {
  if (!graph.nodes.has(id)) {
    registerStateNode(graph, compositeStack, { id, label: id, shape: 'rounded' })
  } else {
    if (compositeStack.length > 0) {
      const current = compositeStack[compositeStack.length - 1]!
      if (!current.nodeIds.includes(id)) {
        current.nodeIds.push(id)
      }
    }
  }
}


function parseStyleProps(propsStr: string): Record<string, string> {
  const cleaned = propsStr.replace(/;\s*$/, '')
  const props: Record<string, string> = {}
  for (const pair of cleaned.split(',')) {
    const colonIdx = pair.indexOf(':')
    if (colonIdx > 0) {
      const key = pair.slice(0, colonIdx).trim()
      const val = pair.slice(colonIdx + 1).trim()
      if (key && val) {
        props[key] = val
      }
    }
  }
  return props
}


const ARROW_REGEX = /^(<)?(-->|-.->|==>|---|-\.-|===)(?:\|([^|]*)\|)?/

const TEXT_ARROW_REGEX = /^(<)?(--|-\.|==)\s+(.+?)\s+(-->|---|\.\->|-\.\-|==>|===)/

const NODE_PATTERNS: Array<{ regex: RegExp; shape: NodeShape }> = [
  { regex: /^([\w-]+)\(\(\((.+?)\)\)\)/, shape: 'doublecircle' },  // A(((text)))

  { regex: /^([\w-]+)\(\[(.+?)\]\)/,     shape: 'stadium' },       // A([text])
  { regex: /^([\w-]+)\(\((.+?)\)\)/,     shape: 'circle' },        // A((text))
  { regex: /^([\w-]+)\[\[(.+?)\]\]/,     shape: 'subroutine' },    // A[[text]]
  { regex: /^([\w-]+)\[\((.+?)\)\]/,     shape: 'cylinder' },      // A[(text)]

  { regex: /^([\w-]+)\[\/(.+?)\\\]/,     shape: 'trapezoid' },     // A[/text\]
  { regex: /^([\w-]+)\[\\(.+?)\/\]/,     shape: 'trapezoid-alt' }, // A[\text/]

  { regex: /^([\w-]+)>(.+?)\]/,          shape: 'asymmetric' },    // A>text]

  { regex: /^([\w-]+)\{\{(.+?)\}\}/,     shape: 'hexagon' },       // A{{text}}

  { regex: /^([\w-]+)\[(.+?)\]/,         shape: 'rectangle' },     // A[text]
  { regex: /^([\w-]+)\((.+?)\)/,         shape: 'rounded' },       // A(text)
  { regex: /^([\w-]+)\{(.+?)\}/,         shape: 'diamond' },       // A{text}
]

const BARE_NODE_REGEX = /^([\w-]+)/

const CLASS_SHORTHAND_REGEX = /^:::([\w][\w-]*)/

function parseEdgeLine(
  line: string,
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[]
): void {
  let remaining = line.trim()

  const firstGroup = consumeNodeGroup(remaining, graph, subgraphStack)
  if (!firstGroup || firstGroup.ids.length === 0) return

  remaining = firstGroup.remaining.trim()
  let prevGroupIds = firstGroup.ids

  while (remaining.length > 0) {
    let hasArrowStart: boolean
    let style: EdgeStyle
    let hasArrowEnd: boolean
    let edgeLabel: string | undefined

    const arrowMatch = remaining.match(ARROW_REGEX)
    if (arrowMatch) {
      hasArrowStart = Boolean(arrowMatch[1])
      const arrowOp = arrowMatch[2]!
      const rawEdgeLabel = arrowMatch[3]?.trim()
      edgeLabel = rawEdgeLabel ? normalizeBrTags(rawEdgeLabel) : undefined
      remaining = remaining.slice(arrowMatch[0].length).trim()
      style = arrowStyleFromOp(arrowOp)
      hasArrowEnd = arrowOp.endsWith('>')
    } else {
      const textMatch = remaining.match(TEXT_ARROW_REGEX)
      if (!textMatch) break
      hasArrowStart = Boolean(textMatch[1])
      const rawLabel = textMatch[3]!.trim()
      edgeLabel = rawLabel ? normalizeBrTags(rawLabel) : undefined
      const openOp = textMatch[2]!
      const closeOp = textMatch[4]!
      remaining = remaining.slice(textMatch[0].length).trim()
      style = textArrowStyleFromOps(openOp, closeOp)
      hasArrowEnd = closeOp.endsWith('>')
    }

    const nextGroup = consumeNodeGroup(remaining, graph, subgraphStack)
    if (!nextGroup || nextGroup.ids.length === 0) break

    remaining = nextGroup.remaining.trim()

    for (const sourceId of prevGroupIds) {
      for (const targetId of nextGroup.ids) {
        graph.edges.push({
          source: sourceId,
          target: targetId,
          label: edgeLabel,
          style,
          hasArrowStart,
          hasArrowEnd,
        })
      }
    }

    prevGroupIds = nextGroup.ids
  }
}

interface ConsumedNodeGroup {
  ids: string[]
  remaining: string
}

function consumeNodeGroup(
  text: string,
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[]
): ConsumedNodeGroup | null {
  const first = consumeNode(text, graph, subgraphStack)
  if (!first) return null

  const ids = [first.id]
  let remaining = first.remaining.trim()

  while (remaining.startsWith('&')) {
    remaining = remaining.slice(1).trim()
    const next = consumeNode(remaining, graph, subgraphStack)
    if (!next) break
    ids.push(next.id)
    remaining = next.remaining.trim()
  }

  return { ids, remaining }
}

interface ConsumedNode {
  id: string
  remaining: string
}

function consumeNode(
  text: string,
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[]
): ConsumedNode | null {
  let id: string | null = null
  let remaining: string = text

  for (const { regex, shape } of NODE_PATTERNS) {
    const match = text.match(regex)
    if (match) {
      id = match[1]!
      const label = normalizeBrTags(match[2]!)
      registerNode(graph, subgraphStack, { id, label, shape })
      remaining = text.slice(match[0].length)
      break
    }
  }

  if (id === null) {
    const bareMatch = text.match(BARE_NODE_REGEX)
    if (bareMatch) {
      id = bareMatch[1]!
      if (!graph.nodes.has(id)) {
        registerNode(graph, subgraphStack, { id, label: id, shape: 'rectangle' })
      }
      remaining = text.slice(bareMatch[0].length)
    }
  }

  if (id === null) return null

  const classMatch = remaining.match(CLASS_SHORTHAND_REGEX)
  if (classMatch) {
    graph.classAssignments.set(id, classMatch[1]!)
    remaining = remaining.slice(classMatch[0].length)
  }

  return { id, remaining }
}

function registerNode(
  graph: MermaidGraph,
  subgraphStack: MermaidSubgraph[],
  node: MermaidNode
): void {
  const isNew = !graph.nodes.has(node.id)
  if (isNew) {
    graph.nodes.set(node.id, node)
  }
  trackInSubgraph(subgraphStack, node.id)
}

function trackInSubgraph(subgraphStack: MermaidSubgraph[], nodeId: string): void {
  if (subgraphStack.length > 0) {
    const current = subgraphStack[subgraphStack.length - 1]!
    if (!current.nodeIds.includes(nodeId)) {
      current.nodeIds.push(nodeId)
    }
  }
}

function arrowStyleFromOp(op: string): EdgeStyle {
  if (op === '-.->') return 'dotted'
  if (op === '-.-') return 'dotted'
  if (op === '==>') return 'thick'
  if (op === '===') return 'thick'
  return 'solid'
}

function textArrowStyleFromOps(openOp: string, closeOp: string): EdgeStyle {
  if (openOp === '-.' || closeOp === '.->' || closeOp === '-.-') return 'dotted'
  if (openOp === '==' || closeOp === '==>' || closeOp === '===') return 'thick'
  return 'solid'
}
