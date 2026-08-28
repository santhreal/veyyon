export function jaccardIndex(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection += 1;
	}
	return intersection / (a.size + b.size - intersection);
}

export function overlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection += 1;
	}
	return intersection / Math.max(a.size, b.size);
}

export function wordSet(text: string): Set<string> {
	const words = new Set<string>();
	for (const word of text.toLowerCase().split(/\s+/)) {
		if (word.length !== 0) words.add(word);
	}
	return words;
}

export function jaccardWordSimilarity(textA: string, textB: string): number {
	return jaccardIndex(wordSet(textA), wordSet(textB));
}
