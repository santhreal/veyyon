export interface JsonlSkip {
	offset: number;
	snippet: string;
}

const SNIPPET_MAX = 200;

export interface ParseJsonlIncrementalOptions {
	onSkip?: (skip: JsonlSkip) => void;
}

export interface JsonlIncrementalResult<T> {
	items: T[];
	carry: string;
}

export function parseJsonlIncremental<T = unknown>(
	text: string,
	carry: string,
	options?: ParseJsonlIncrementalOptions,
): JsonlIncrementalResult<T> {
	const buffer = carry + text;
	const lines = buffer.split("\n");
	const nextCarry = lines.pop() ?? "";
	const items: T[] = [];
	let offset = 0;
	for (const line of lines) {
		const start = offset;
		offset += line.length + 1;
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			items.push(JSON.parse(trimmed) as T);
		} catch {
			options?.onSkip?.({ offset: start, snippet: trimmed.slice(0, SNIPPET_MAX) });
		}
	}
	return { items, carry: nextCarry };
}
