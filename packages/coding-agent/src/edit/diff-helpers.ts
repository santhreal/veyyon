export interface DiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface DiffError {
	error: string;
}

export interface DiffHunk {
	changeContext?: string;
	oldStartLine?: number;
	newStartLine?: number;
	hasContextLines: boolean;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}
