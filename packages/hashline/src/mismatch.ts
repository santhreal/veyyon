import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./format";
import { formatAnchoredContext } from "./messages";

import type { MismatchDetails } from "./mismatch-helpers";

export { formatFullAnchorRequirement, parseTag } from "./mismatch-helpers";

export class MismatchError extends Error {
	readonly path: string | undefined;
	readonly expectedFileHash: string;
	readonly actualFileHash: string;
	readonly fileLines: string[];
	readonly anchorLines: readonly number[];
	readonly hashRecognized: boolean;

	constructor(details: MismatchDetails) {
		super(MismatchError.formatMessage(details));
		this.name = "MismatchError";
		this.path = details.path;
		this.expectedFileHash = details.expectedFileHash;
		this.actualFileHash = details.actualFileHash;
		this.fileLines = details.fileLines;
		this.anchorLines = details.anchorLines ?? [];
		this.hashRecognized = details.hashRecognized ?? true;
	}

	get displayMessage(): string {
		return MismatchError.formatDisplayMessage({
			path: this.path,
			expectedFileHash: this.expectedFileHash,
			actualFileHash: this.actualFileHash,
			fileLines: this.fileLines,
			anchorLines: this.anchorLines,
			hashRecognized: this.hashRecognized,
		});
	}

	static rejectionHeader(details: MismatchDetails): string[] {
		const pathText = details.path ? ` for ${details.path}` : "";
		const hashRecognized = details.hashRecognized ?? true;
		if (!hashRecognized) {
			return [
				`Edit rejected${pathText}: hash ${HL_FILE_HASH_SEP}${details.expectedFileHash} is not from this session.`,
				`The current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}. Re-read the file with \`read\` to copy a current ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX} header — never invent the tag and never reuse one from a prior session.`,
			];
		}
		return [
			`Edit rejected${pathText}: file changed between read and edit.`,
			`Section is bound to ${HL_FILE_HASH_SEP}${details.expectedFileHash}, but the current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}. If a prior edit in this session modified this file, copy the ${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}newhash${HL_FILE_SUFFIX} header from that edit's response; otherwise re-read the file with \`read\` to refresh the tag before retrying.`,
		];
	}

	static formatDisplayMessage(details: MismatchDetails): string {
		return MismatchError.formatMessage(details);
	}

	static formatMessage(details: MismatchDetails): string {
		const lines = MismatchError.rejectionHeader(details);
		let anchorLines = details.anchorLines ?? [];
		if (anchorLines.length === 0 && details.fileLines && details.fileLines.length > 0) {
			anchorLines = [1];
		}
		const context = formatAnchoredContext(anchorLines, details.fileLines);
		if (context.length === 0) return lines.join("\n");
		lines.push("", ...context);
		return lines.join("\n");
	}
}

export function validateLineRef(ref: { line: number }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
}
