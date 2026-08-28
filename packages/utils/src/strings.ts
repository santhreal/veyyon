export function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

export function nonEmptyTrimmed(values: Iterable<string | undefined | null>): string[] {
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}
