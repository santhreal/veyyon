import type { OperatorNotices } from "./operator-notices";

export const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface SessionLoadOptions {
	source?: string;
	operatorNotices?: OperatorNotices;
}

export interface SessionRecordIssue {
	line: number;
	byteOffset: number;
	problem: string;
}
