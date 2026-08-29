
export interface ErDiagram {
  entities: ErEntity[]
  relationships: ErRelationship[]
}

export interface ErEntity {
  id: string
  label: string
  attributes: ErAttribute[]
}

export interface ErAttribute {
  type: string
  name: string
  keys: Array<'PK' | 'FK' | 'UK'>
  comment?: string
}

export type Cardinality = 'one' | 'zero-one' | 'many' | 'zero-many'

export interface ErRelationship {
  entity1: string
  entity2: string
  cardinality1: Cardinality
  cardinality2: Cardinality
  label: string
  identifying: boolean
}


export interface PositionedErEntity {
  id: string
  label: string
  attributes: ErAttribute[]
  x: number
  y: number
  width: number
  height: number
  headerHeight: number
  rowHeight: number
}

export interface PositionedErRelationship {
  entity1: string
  entity2: string
  cardinality1: Cardinality
  cardinality2: Cardinality
  label: string
  identifying: boolean
  points: Array<{ x: number; y: number }>
}
