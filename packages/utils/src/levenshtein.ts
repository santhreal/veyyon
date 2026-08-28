import { clampLow } from "./math";

export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

export function damerauLevenshteinDistance(a: string, b: string): number {
	const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
	for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = best;
		}
	}
	return rows[a.length]![b.length]!;
}

export function nearestNames(typed: string, candidates: Iterable<string>, limit = 5): string[] {
	const needle = typed.trim().toLowerCase();
	if (needle.length === 0) return [];

	const all = Array.from(candidates);
	const out: string[] = [];
	const seen = new Set<string>();
	const take = (names: readonly string[]): void => {
		for (const name of names) {
			if (out.length >= limit) return;
			if (seen.has(name)) continue;
			seen.add(name);
			out.push(name);
		}
	};

	take(all.filter(name => name.toLowerCase() === needle));
	take(all.filter(name => name.toLowerCase().includes(needle)));
	const budget = clampLow(Math.floor(needle.length / 4), 1, 3);
	take(
		all
			.map(name => ({ name, distance: damerauLevenshteinDistance(needle, name.toLowerCase()) }))
			.filter(entry => entry.distance <= budget)
			.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
			.map(entry => entry.name),
	);
	return out;
}
