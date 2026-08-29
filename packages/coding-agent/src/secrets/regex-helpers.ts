import { errorMessage } from "@veyyon/utils/type-guards";

export const MAX_PATTERN_LENGTH = 4096;
export const MAX_GROUP_DEPTH = 64;
export const MAX_FLAG_LENGTH = 16;

export interface PatternAnalysis {
	nullable: boolean;
	minimumWidth: number;
	maximumWidth: number;
	variableWidthAlternations: number;
	hasVariableQuantifier: boolean;
	hasAlternation: boolean;
	startsWithVariableAtom: string | undefined;
	endsWithVariableAtom: string | undefined;
}

export function enforceGlobalFlag(flags: string): string {
	if (flags.includes("y")) {
		throw new Error('the sticky "y" flag is incompatible with global secret scanning');
	}
	return flags.includes("g") ? flags : `${flags}g`;
}

export function splitRegexLiteral(pattern: string): { pattern: string; flags: string } | undefined {
	if (!pattern.startsWith("/")) return undefined;

	for (let index = pattern.length - 1; index > 0; index--) {
		if (pattern[index] !== "/") continue;
		let precedingBackslashes = 0;
		for (let cursor = index - 1; cursor >= 0 && pattern[cursor] === "\\"; cursor--) precedingBackslashes++;
		if (precedingBackslashes % 2 !== 0) continue;

		const flags = pattern.slice(index + 1);
		if (!/^[A-Za-z]*$/.test(flags)) {
			throw new Error("regex literal flags must contain only ASCII letters");
		}
		return { pattern: pattern.slice(1, index), flags };
	}
	return undefined;
}

export function validateFlags(flags: string, source: string): void {
	if (flags.length > MAX_FLAG_LENGTH) {
		throw new Error(`${source} regex flags are too long to be valid`);
	}
	if (flags.includes("y")) {
		throw new Error(`the sticky "y" flag in ${source} is incompatible with global secret scanning`);
	}
	try {
		new RegExp("", flags);
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(`${source} has invalid or incompatible regex flags ${JSON.stringify(flags)} (${message})`);
	}
}
