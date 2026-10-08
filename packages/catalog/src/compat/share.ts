/**
 * One resolved compat record per distinct shape.
 *
 * `buildCompat` allocates a record per model, and the catalog holds thousands
 * of models over a few hundred distinct records. `shareCompat` returns the live
 * record structurally equal to its argument, so models with equal compat hold
 * one object between them.
 *
 * A shared record is frozen, nested values included: a write through one model
 * would otherwise reach every model that holds the record.
 *
 * The table holds its records weakly. Entries whose record was collected are
 * swept once the table doubles in size since the last sweep, so it never holds
 * more than twice the entries it held live at that sweep, and at least
 * {@link MIN_SWEEP_SIZE}.
 */

/** Hash of a record's JSON text → records with that hash, live or collected. */
const shapes = new Map<bigint | number, WeakRef<object>[]>();

const MIN_SWEEP_SIZE = 64;
let sweepAt = MIN_SWEEP_SIZE;

/**
 * The live record structurally equal to `compat`, or `compat` itself, frozen,
 * when no model holds an equal one. JSON text narrows the candidates; strict
 * deep equality decides, so a record differing only in an own `undefined`
 * field, a `-0`, a `NaN` or an array hole is never merged with one that JSON
 * prints the same.
 */
export function shareCompat<T>(compat: T): T {
	if (compat === null || typeof compat !== "object") return compat;
	// Bun: node:crypto has no non-cryptographic string hash, and `createHash`
	// per record costs several times the catalog build it runs inside.
	const hash = Bun.hash(JSON.stringify(compat));
	const bucket = shapes.get(hash);
	if (bucket) {
		for (const ref of bucket) {
			const record = ref.deref();
			if (record !== undefined && Bun.deepEquals(record, compat, true)) return record as T;
		}
	}
	freezeData(compat);
	const ref = new WeakRef(compat);
	if (bucket) {
		bucket.push(ref);
	} else {
		if (shapes.size >= sweepAt) sweep();
		shapes.set(hash, [ref]);
	}
	return compat;
}

/** Drops every entry whose record was collected and sets the size of the next sweep. */
function sweep(): void {
	for (const [hash, bucket] of shapes) {
		const live = bucket.filter(ref => ref.deref() !== undefined);
		if (live.length === 0) shapes.delete(hash);
		else if (live.length !== bucket.length) shapes.set(hash, live);
	}
	sweepAt = Math.max(MIN_SWEEP_SIZE, shapes.size * 2);
}

function freezeData(value: object): void {
	Object.freeze(value);
	for (const item of Object.values(value)) {
		if (item !== null && typeof item === "object") freezeData(item);
	}
}
