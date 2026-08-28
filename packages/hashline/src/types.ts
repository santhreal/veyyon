export interface Anchor {
	line: number;
}

export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

export type Edit =
	| {
			kind: "insert";
			cursor: Cursor;
			text: string;
			lineNum: number;
			index: number;
			mode?: "replacement";
			blockStart?: number;
	  }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string }
	| {
			kind: "block";
			anchor: Anchor;
			payloads: string[];
			mode?: "insert_after";
			lineNum: number;
			index: number;
	  };

export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

export interface ApplyResult {
	text: string;
	firstChangedLine?: number;
	warnings?: string[];
	blockResolutions?: BlockResolution[];
}

export interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

export interface SplitOptions {
	cwd?: string;
	path?: string;
}

export interface StreamOptions {
	startLine?: number;
	maxChunkLines?: number;
	maxChunkBytes?: number;
}

export interface CompactDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

export interface CompactDiffOptions {
	maxAddedRunContext?: number;
	maxUnchangedRun?: number;
}

export interface BlockSpan {
	start: number;
	end: number;
}

export interface BlockResolution {
	anchorLine: number;
	start: number;
	end: number;
	op: "replace" | "delete" | "insert_after";
}

export interface BlockResolverRequest {
	path: string;
	text: string;
	line: number;
}

export type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null;
