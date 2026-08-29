export interface TruncationOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
	artifactId?: string;
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail" | "middle";
	startLine?: number;
	totalFileLines?: number;
}

export interface TruncationTextOptions {
	direction: "head" | "tail" | "middle";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
}
