/** Hard-cap helper for host→guest collab frames. The host wraps every {@link CollabFrame} in an AES-GCM envelope and ships it */

/** Per-payload ceiling for host→guest frames. Bun's default WebSocket `maxPayloadLength` is 16 MB; we leave a generous margin so the AES-GCM */
export const MAX_REPLICATED_PAYLOAD_BYTES = 1 * 1024 * 1024;

/** Progressive shrink passes. Each pass tightens both the per-string cap and the per-array head limit; the loop stops at the first pass whose output */
interface ShrinkPass {
	stringCap: number;
	arrayLimit: number;
}

const SHRINK_PASSES: readonly ShrinkPass[] = [
	{ stringCap: 64 * 1024, arrayLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64 },
	{ stringCap: 1 * 1024, arrayLimit: 32 },
	{ stringCap: 256, arrayLimit: 16 },
	{ stringCap: 256, arrayLimit: 4 },
	{ stringCap: 64, arrayLimit: 1 },
];

const STRING_ELISION_RESERVE = 80;

/** Recursively walk `value`, head-truncating any string longer than `stringCap` and head-clipping any array longer than `arrayLimit`. Returns */
function shrinkWalk(value: unknown, stringCap: number, arrayLimit: number): unknown {
	if (typeof value === "string") {
		if (value.length <= stringCap) return value;
		const headLen = Math.max(0, stringCap - STRING_ELISION_RESERVE);
		return `${value.slice(0, headLen)}\n…[${value.length - headLen} chars elided for collab session]`;
	}
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, arrayLimit);
		const elided = value.length - keep;
		const out: unknown[] = new Array(elided > 0 ? keep + 1 : keep);
		for (let i = 0; i < keep; i++) out[i] = shrinkWalk(value[i], stringCap, arrayLimit);
		if (elided > 0) out[keep] = `…[${elided} items elided for collab session]`;
		return out;
	}
	if (value && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k in src) out[k] = shrinkWalk(src[k], stringCap, arrayLimit);
		return out;
	}
	return value;
}

/** Return `value` unchanged when its JSON serialization already fits {@link MAX_REPLICATED_PAYLOAD_BYTES}; otherwise return a deep-cloned */
export function shrinkForReplication<T>(value: T): T {
	if (JSON.stringify(value).length <= MAX_REPLICATED_PAYLOAD_BYTES) return value;
	let shrunk: unknown = value;
	for (const pass of SHRINK_PASSES) {
		shrunk = shrinkWalk(value, pass.stringCap, pass.arrayLimit);
		if (JSON.stringify(shrunk).length <= MAX_REPLICATED_PAYLOAD_BYTES) return shrunk as T;
	}
	return shrunk as T;
}
