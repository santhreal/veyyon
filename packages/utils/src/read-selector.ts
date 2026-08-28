export const READ_SELECTOR_RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;

export const READ_SELECTOR_RANGE_LIST_SRC = `${READ_SELECTOR_RANGE_CHUNK_SRC}(?:,${READ_SELECTOR_RANGE_CHUNK_SRC})*`;

const SELECTOR_RE = new RegExp(`^(?:${READ_SELECTOR_RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const RANGE_ONLY_RE = new RegExp(`^${READ_SELECTOR_RANGE_LIST_SRC}$`, "i");
const RAW_ONLY_RE = /^raw$/i;

export function splitReadSelector(path: string): { path: string; sel?: string } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path };
	const candidate = path.slice(colon + 1);
	if (!SELECTOR_RE.test(candidate)) return { path };
	let base = path.slice(0, colon);
	let sel = candidate;
	const inner = base.lastIndexOf(":");
	if (inner > 0) {
		const innerCandidate = base.slice(inner + 1);
		const innerIsRaw = RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = RAW_ONLY_RE.test(candidate);
		const innerIsRange = RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			base = base.slice(0, inner);
		}
	}
	return { path: base, sel };
}

export function stripReadSelector(path: string): string {
	return splitReadSelector(path).path;
}
