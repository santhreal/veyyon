
import type { MermaidGraph, MermaidSubgraph } from '../types'
import type {
  AsciiGraph, AsciiNode, AsciiEdge, AsciiSubgraph, AsciiConfig,
} from './types'
import { EMPTY_STYLE } from './types'
import { mkCanvas, mkRoleCanvas } from './canvas'

export function convertToAsciiGraph(parsed: MermaidGraph, config: AsciiConfig): AsciiGraph {
  const nodeMap = new Map<string, AsciiNode>()
  let index = 0

  for (const [id, mNode] of parsed.nodes) {
    const asciiNode: AsciiNode = {
      name: id,
      displayLabel: mNode.label,
      shape: mNode.shape,
      index,
      gridCoord: null,
      drawingCoord: null,
      drawing: null,
      drawn: false,
      styleClassName: '',
      styleClass: EMPTY_STYLE,
    }
    nodeMap.set(id, asciiNode)
    index++
  }

  const nodes = [...nodeMap.values()]

  const edges: AsciiEdge[] = []
  for (const mEdge of parsed.edges) {
    const from = nodeMap.get(mEdge.source)
    const to = nodeMap.get(mEdge.target)
    if (!from || !to) continue

    edges.push({
      from,
      to,
      text: mEdge.label ?? '',
      path: [],
      labelLine: [],
      startDir: { x: 0, y: 0 },
      endDir: { x: 0, y: 0 },
      style: mEdge.style,
      hasArrowStart: mEdge.hasArrowStart,
      hasArrowEnd: mEdge.hasArrowEnd,
    })
  }

  const subgraphs: AsciiSubgraph[] = []
  for (const mSg of parsed.subgraphs) {
    convertSubgraph(mSg, null, nodeMap, subgraphs)
  }

  deduplicateSubgraphNodes(parsed.subgraphs, subgraphs, nodeMap, parsed)

  for (const [nodeId, className] of parsed.classAssignments) {
    const node = nodeMap.get(nodeId)
    const classDef = parsed.classDefs.get(className)
    if (node && classDef) {
      node.styleClassName = className
      node.styleClass = { name: className, styles: classDef }
    }
  }

  return {
    nodes,
    edges,
    canvas: mkCanvas(0, 0),
    roleCanvas: mkRoleCanvas(0, 0),
    grid: new Map(),
    columnWidth: new Map(),
    rowHeight: new Map(),
    subgraphs,
    config,
    offsetX: 0,
    offsetY: 0,
    bundles: [], // Populated by analyzeEdgeBundles() during layout
  }
}

function convertSubgraph(
  mSg: MermaidSubgraph,
  parent: AsciiSubgraph | null,
  nodeMap: Map<string, AsciiNode>,
  allSubgraphs: AsciiSubgraph[],
): AsciiSubgraph {
  let normalizedDirection: 'LR' | 'TD' | undefined
  if (mSg.direction) {
    normalizedDirection = (mSg.direction === 'LR' || mSg.direction === 'RL') ? 'LR' : 'TD'
  }

  const sg: AsciiSubgraph = {
    name: mSg.label,
    nodes: [],
    parent,
    children: [],
    minX: 0, minY: 0, maxX: 0, maxY: 0,
    direction: normalizedDirection,
  }

  for (const nodeId of mSg.nodeIds) {
    const node = nodeMap.get(nodeId)
    if (node) sg.nodes.push(node)
  }

  allSubgraphs.push(sg)

  for (const childMSg of mSg.children) {
    const child = convertSubgraph(childMSg, sg, nodeMap, allSubgraphs)
    sg.children.push(child)

    for (const childNode of child.nodes) {
      if (!sg.nodes.includes(childNode)) {
        sg.nodes.push(childNode)
      }
    }
  }

  return sg
}

function deduplicateSubgraphNodes(
  mermaidSubgraphs: MermaidSubgraph[],
  asciiSubgraphs: AsciiSubgraph[],
  nodeMap: Map<string, AsciiNode>,
  parsed: MermaidGraph,
): void {
  const sgMap = new Map<MermaidSubgraph, AsciiSubgraph>()
  buildSgMap(mermaidSubgraphs, asciiSubgraphs, sgMap)

  const nodeOwner = new Map<string, AsciiSubgraph>() // nodeId → owning subgraph

  function claimNodes(mSg: MermaidSubgraph): void {
    const asciiSg = sgMap.get(mSg)
    if (!asciiSg) return

    for (const child of mSg.children) {
      claimNodes(child)
    }

    for (const nodeId of mSg.nodeIds) {
      if (!nodeOwner.has(nodeId)) {
        nodeOwner.set(nodeId, asciiSg)
      }
    }
  }

  for (const mSg of mermaidSubgraphs) {
    claimNodes(mSg)
  }

  for (const asciiSg of asciiSubgraphs) {
    asciiSg.nodes = asciiSg.nodes.filter(node => {
      let nodeId: string | undefined
      for (const [id, n] of nodeMap) {
        if (n === node) { nodeId = id; break }
      }
      if (!nodeId) return false

      const owner = nodeOwner.get(nodeId)
      if (!owner) return true // not in any subgraph claim — keep as-is

      return isAncestorOrSelf(asciiSg, owner)
    })
  }
}

function isAncestorOrSelf(candidate: AsciiSubgraph, target: AsciiSubgraph): boolean {
  let current: AsciiSubgraph | null = target
  while (current !== null) {
    if (current === candidate) return true
    current = current.parent
  }
  return false
}

function buildSgMap(
  mSgs: MermaidSubgraph[],
  aSgs: AsciiSubgraph[],
  result: Map<MermaidSubgraph, AsciiSubgraph>,
): void {
  const flatMermaid: MermaidSubgraph[] = []
  function flatten(sgs: MermaidSubgraph[]): void {
    for (const sg of sgs) {
      flatMermaid.push(sg)
      flatten(sg.children)
    }
  }
  flatten(mSgs)

  for (let i = 0; i < flatMermaid.length && i < aSgs.length; i++) {
    result.set(flatMermaid[i]!, aSgs[i]!)
  }
}
