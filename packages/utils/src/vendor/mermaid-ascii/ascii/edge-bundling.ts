
import type {
  AsciiGraph, AsciiNode, AsciiEdge, EdgeBundle, GridCoord, Direction,
} from './types'
import { Up, Down, Left, Right, Middle, gridKey, gridCoordEquals } from './types'
import { getPath, mergePath } from './pathfinder'
import { getNodeSubgraph } from './grid'


export function analyzeEdgeBundles(graph: AsciiGraph): EdgeBundle[] {
  if (graph.config.graphDirection !== 'TD') {
    return []
  }
  const bundles: EdgeBundle[] = []
  const bundledEdges = new Set<AsciiEdge>()

  const edgesByTarget = new Map<AsciiNode, AsciiEdge[]>()
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue

    const existing = edgesByTarget.get(edge.to) ?? []
    existing.push(edge)
    edgesByTarget.set(edge.to, existing)
  }

  for (const [target, edges] of edgesByTarget) {
    if (edges.length < 2) continue
    if (!canBundle(edges, graph)) continue

    if (edges.some(e => bundledEdges.has(e))) continue

    const bundle: EdgeBundle = {
      type: 'fan-in',
      edges: [...edges],
      sharedNode: target,
      otherNodes: edges.map(e => e.from),
      junctionPoint: null,
      sharedPath: [],
      junctionDir: Middle,
      sharedNodeDir: Middle,
    }

    for (const edge of edges) {
      edge.bundle = bundle
      bundledEdges.add(edge)
    }

    bundles.push(bundle)
  }

  const edgesBySource = new Map<AsciiNode, AsciiEdge[]>()
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue
    if (bundledEdges.has(edge)) continue

    const existing = edgesBySource.get(edge.from) ?? []
    existing.push(edge)
    edgesBySource.set(edge.from, existing)
  }

  for (const [source, edges] of edgesBySource) {
    if (edges.length < 2) continue
    if (!canBundle(edges, graph)) continue

    const bundle: EdgeBundle = {
      type: 'fan-out',
      edges: [...edges],
      sharedNode: source,
      otherNodes: edges.map(e => e.to),
      junctionPoint: null,
      sharedPath: [],
      junctionDir: Middle,
      sharedNodeDir: Middle,
    }

    for (const edge of edges) {
      edge.bundle = bundle
      bundledEdges.add(edge)
    }

    bundles.push(bundle)
  }

  return bundles
}

function canBundle(edges: AsciiEdge[], graph: AsciiGraph): boolean {
  if (edges.length < 2) return false

  const firstStyle = edges[0]!.style
  const firstFromSg = getNodeSubgraph(graph, edges[0]!.from)
  const firstToSg = getNodeSubgraph(graph, edges[0]!.to)

  for (const edge of edges) {
    if (edge.style !== firstStyle) return false

    if (edge.text.length > 0) return false

    const fromSg = getNodeSubgraph(graph, edge.from)
    const toSg = getNodeSubgraph(graph, edge.to)
    if (fromSg !== firstFromSg || toSg !== firstToSg) return false

    if (fromSg !== toSg) return false
  }

  return true
}


export function calculateJunctionPoint(
  graph: AsciiGraph,
  bundle: EdgeBundle,
): GridCoord {
  const dir = graph.config.graphDirection
  const sharedCoord = bundle.sharedNode.gridCoord!
  const otherCoords = bundle.otherNodes.map(n => n.gridCoord!)

  if (bundle.type === 'fan-in') {
    const minX = Math.min(...otherCoords.map(c => c.x))
    const maxX = Math.max(...otherCoords.map(c => c.x))
    const minY = Math.min(...otherCoords.map(c => c.y))
    const maxY = Math.max(...otherCoords.map(c => c.y))

    if (dir === 'TD') {
      const junctionY = sharedCoord.y - 1
      const centerX = Math.floor((minX + maxX) / 2) + 1 // +1 for center of 3x3 block
      const junctionX = sharedCoord.x + 1 // Align with target's center

      return { x: junctionX, y: junctionY }
    } else {
      const junctionX = sharedCoord.x - 1
      const junctionY = sharedCoord.y + 1 // Align with target's center

      return { x: junctionX, y: junctionY }
    }
  } else {
    const minX = Math.min(...otherCoords.map(c => c.x))
    const maxX = Math.max(...otherCoords.map(c => c.x))
    const minY = Math.min(...otherCoords.map(c => c.y))
    const maxY = Math.max(...otherCoords.map(c => c.y))

    if (dir === 'TD') {
      const junctionY = sharedCoord.y + 3 // Just below source's 3x3 block
      const junctionX = sharedCoord.x + 1 // Align with source's center

      return { x: junctionX, y: junctionY }
    } else {
      const junctionX = sharedCoord.x + 3
      const junctionY = sharedCoord.y + 1

      return { x: junctionX, y: junctionY }
    }
  }
}


export function routeBundledEdges(graph: AsciiGraph, bundle: EdgeBundle): void {
  const dir = graph.config.graphDirection

  bundle.junctionPoint = calculateJunctionPoint(graph, bundle)
  const junction = bundle.junctionPoint

  if (bundle.type === 'fan-in') {
    bundle.junctionDir = dir === 'TD' ? Up : Left
    bundle.sharedNodeDir = dir === 'TD' ? Down : Right

    const targetCoord = bundle.sharedNode.gridCoord!
    const targetEntry = dir === 'TD'
      ? { x: targetCoord.x + 1, y: targetCoord.y } // Top center of target
      : { x: targetCoord.x, y: targetCoord.y + 1 } // Left center of target

    const sharedPath = getPath(graph.grid, junction, targetEntry)
    bundle.sharedPath = sharedPath ? mergePath(sharedPath) : [junction, targetEntry]

    for (const edge of bundle.edges) {
      const sourceCoord = edge.from.gridCoord!
      const sourceExit = dir === 'TD'
        ? { x: sourceCoord.x + 1, y: sourceCoord.y + 2 } // Bottom center of source
        : { x: sourceCoord.x + 2, y: sourceCoord.y + 1 } // Right center of source

      const pathToJunction = getPath(graph.grid, sourceExit, junction)
      edge.pathToJunction = pathToJunction ? mergePath(pathToJunction) : [sourceExit, junction]

      edge.startDir = dir === 'TD' ? Down : Right
      edge.endDir = dir === 'TD' ? Up : Left

      edge.path = [...edge.pathToJunction, ...bundle.sharedPath.slice(1)]
    }
  } else {
    bundle.junctionDir = dir === 'TD' ? Down : Right
    bundle.sharedNodeDir = dir === 'TD' ? Up : Left

    const sourceCoord = bundle.sharedNode.gridCoord!
    const sourceExit = dir === 'TD'
      ? { x: sourceCoord.x + 1, y: sourceCoord.y + 2 } // Bottom center of source
      : { x: sourceCoord.x + 2, y: sourceCoord.y + 1 } // Right center of source

    const sharedPath = getPath(graph.grid, sourceExit, junction)
    bundle.sharedPath = sharedPath ? mergePath(sharedPath) : [sourceExit, junction]

    for (const edge of bundle.edges) {
      const targetCoord = edge.to.gridCoord!
      const targetEntry = dir === 'TD'
        ? { x: targetCoord.x + 1, y: targetCoord.y } // Top center of target
        : { x: targetCoord.x, y: targetCoord.y + 1 } // Left center of target

      const pathToJunction = getPath(graph.grid, junction, targetEntry)
      edge.pathToJunction = pathToJunction ? mergePath(pathToJunction) : [junction, targetEntry]

      edge.startDir = dir === 'TD' ? Down : Right
      edge.endDir = dir === 'TD' ? Up : Left

      edge.path = [...bundle.sharedPath, ...edge.pathToJunction.slice(1)]
    }
  }
}

export function processBundles(graph: AsciiGraph): void {
  for (const bundle of graph.bundles) {
    routeBundledEdges(graph, bundle)
  }
}
