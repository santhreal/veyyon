import { HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./format";

export const LINE_REF_RE = /^\s*[>+\-*]*\s*(\d+)(?::.*)?\s*$/;
export function formatFullAnchorRequirement(raw?: string): string {
	const received = raw === undefined ? "" : ` Received ${JSON.stringify(raw)}.`;
	return (
		`a bare line number from read/search output plus the section header content-hash tag ` +
		`(for example ${HL_FILE_PREFIX}src/foo.ts${HL_FILE_HASH_SEP}${HL_FILE_HASH_EXAMPLES[0]}${HL_FILE_SUFFIX} and line "160")${received}`
	);
}

export function parseTag(ref: string): { line: number } {
	const match = ref.match(LINE_REF_RE);
	if (!match) {
		throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	return { line };
}

export interface MismatchDetails {
	path?: string;
	expectedFileHash: string;
	actualFileHash: string;
	fileLines: string[];
	anchorLines?: readonly number[];
	hashRecognized?: boolean;
}
