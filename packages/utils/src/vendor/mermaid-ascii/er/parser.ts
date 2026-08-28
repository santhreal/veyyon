import type { ErDiagram, ErEntity, ErAttribute, ErRelationship, Cardinality } from './types'
import { normalizeBrTags } from '../multiline-utils'


export function parseErDiagram(lines: string[]): ErDiagram {
  const diagram: ErDiagram = {
    entities: [],
    relationships: [],
  }

  const entityMap = new Map<string, ErEntity>()
  let currentEntity: ErEntity | null = null

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    if (currentEntity) {
      if (line === '}') {
        currentEntity = null
        continue
      }

      const attr = parseAttribute(line)
      if (attr) {
        currentEntity.attributes.push(attr)
      }
      continue
    }

    const entityBlockMatch = line.match(/^(\S+)\s*\{$/)
    if (entityBlockMatch) {
      const id = entityBlockMatch[1]!
      const entity = ensureEntity(entityMap, id)
      currentEntity = entity
      continue
    }

    const rel = parseRelationshipLine(line)
    if (rel) {
      ensureEntity(entityMap, rel.entity1)
      ensureEntity(entityMap, rel.entity2)
      diagram.relationships.push(rel)
      continue
    }
  }

  diagram.entities = [...entityMap.values()]
  return diagram
}

function ensureEntity(entityMap: Map<string, ErEntity>, id: string): ErEntity {
  let entity = entityMap.get(id)
  if (!entity) {
    entity = { id, label: id, attributes: [] }
    entityMap.set(id, entity)
  }
  return entity
}

function parseAttribute(line: string): ErAttribute | null {
  const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/)
  if (!match) return null

  const type = match[1]!
  const name = match[2]!
  const rest = match[3]?.trim() ?? ''

  const keys: ErAttribute['keys'] = []
  let comment: string | undefined

  const commentMatch = rest.match(/"([^"]*)"/)
  if (commentMatch) {
    comment = normalizeBrTags(commentMatch[1]!)
  }

  const restWithoutComment = rest.replace(/"[^"]*"/, '').trim()
  for (const part of restWithoutComment.split(/\s+/)) {
    const upper = part.toUpperCase()
    if (upper === 'PK' || upper === 'FK' || upper === 'UK') {
      keys.push(upper as 'PK' | 'FK' | 'UK')
    }
  }

  return { type, name, keys, comment }
}

function parseRelationshipLine(line: string): ErRelationship | null {
  const match = line.match(/^(\S+)\s+([|o}{]+(?:--|\.\.)[|o}{]+)\s+(\S+)\s*:\s*(.+)$/)
  if (!match) return null

  const entity1 = match[1]!
  const cardinalityStr = match[2]!
  const entity2 = match[3]!
  const rawLabel = match[4]!.trim().replace(/^["']|["']$/g, '')
  const label = normalizeBrTags(rawLabel)

  const lineMatch = cardinalityStr.match(/^([|o}{]+)(--|\.\.?)([|o}{]+)$/)
  if (!lineMatch) return null

  const leftStr = lineMatch[1]!
  const lineStyle = lineMatch[2]!
  const rightStr = lineMatch[3]!

  const cardinality1 = parseCardinality(leftStr)
  const cardinality2 = parseCardinality(rightStr)
  const identifying = lineStyle === '--'

  if (!cardinality1 || !cardinality2) return null

  return { entity1, entity2, cardinality1, cardinality2, label, identifying }
}

function parseCardinality(str: string): Cardinality | null {
  const sorted = str.split('').sort().join('')

  if (sorted === '||') return 'one'
  if (sorted === 'o|') return 'zero-one'
  if (sorted === '|}' || sorted === '{|') return 'many'
  if (sorted === '{o' || sorted === 'o{') return 'zero-many'

  return null
}
