
export interface ClassDiagram {
  classes: ClassNode[]
  relationships: ClassRelationship[]
  namespaces: ClassNamespace[]
}

export interface ClassNode {
  id: string
  label: string
  annotation?: string
  attributes: ClassMember[]
  methods: ClassMember[]
}

export interface ClassMember {
  visibility: '+' | '-' | '#' | '~' | ''
  name: string
  type?: string
  isStatic?: boolean
  isAbstract?: boolean
  isMethod?: boolean
  params?: string
}

export type RelationshipType =
  | 'inheritance'   // A <|-- B   (solid line, hollow triangle)
  | 'composition'   // A *-- B    (solid line, filled diamond)
  | 'aggregation'   // A o-- B    (solid line, hollow diamond)
  | 'association'   // A --> B    (solid line, open arrow)
  | 'dependency'    // A ..> B    (dashed line, open arrow)
  | 'realization'   // A ..|> B   (dashed line, hollow triangle)

export interface ClassRelationship {
  from: string
  to: string
  type: RelationshipType
  markerAt: 'from' | 'to'
  label?: string
  fromCardinality?: string
  toCardinality?: string
}

export interface ClassNamespace {
  name: string
  classIds: string[]
}


export interface PositionedClassDiagram {
  width: number
  height: number
  classes: PositionedClassNode[]
  relationships: PositionedClassRelationship[]
}

export interface PositionedClassNode {
  id: string
  label: string
  annotation?: string
  attributes: ClassMember[]
  methods: ClassMember[]
  x: number
  y: number
  width: number
  height: number
  headerHeight: number
  attrHeight: number
  methodHeight: number
}

export interface PositionedClassRelationship {
  from: string
  to: string
  type: RelationshipType
  markerAt: 'from' | 'to'
  label?: string
  fromCardinality?: string
  toCardinality?: string
  points: Array<{ x: number; y: number }>
  labelPosition?: { x: number; y: number }
}
