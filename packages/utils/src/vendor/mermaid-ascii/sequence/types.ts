
export interface SequenceDiagram {
  actors: Actor[]
  messages: Message[]
  blocks: Block[]
  notes: Note[]
}

export interface Actor {
  id: string
  label: string
  type: 'participant' | 'actor'
}

export interface Message {
  from: string
  to: string
  label: string
  lineStyle: 'solid' | 'dashed'
  arrowHead: 'filled' | 'open'
  activate?: boolean
  deactivate?: boolean
}

export interface Block {
  type: 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'break' | 'rect'
  label: string
  startIndex: number
  endIndex: number
  dividers: Array<{ index: number; label: string }>
}

export interface Note {
  actorIds: string[]
  text: string
  position: 'left' | 'right' | 'over'
  afterIndex: number
}


export interface PositionedActor {
  id: string
  label: string
  type: 'participant' | 'actor'
  x: number
  y: number
  width: number
  height: number
}

export interface Lifeline {
  actorId: string
  x: number
  topY: number
  bottomY: number
}

export interface PositionedMessage {
  from: string
  to: string
  label: string
  lineStyle: 'solid' | 'dashed'
  arrowHead: 'filled' | 'open'
  x1: number
  x2: number
  y: number
  isSelf: boolean
}

export interface Activation {
  actorId: string
  x: number
  topY: number
  bottomY: number
  width: number
}

export interface PositionedBlock {
  type: Block['type']
  label: string
  x: number
  y: number
  width: number
  height: number
  dividers: Array<{ y: number; label: string }>
}

export interface PositionedNote {
  text: string
  x: number
  y: number
  width: number
  height: number
  actors?: string[]
  position?: 'left' | 'right' | 'over'
}
