/**
 * Whether the parsed bundled catalog stays reachable across its hold window, on a virtual clock.
 *
 * Run in a fresh process: in the test runner another file may already hold a parse, and a promise it
 * left on the stack can keep a spec reachable after the catalog has let go of it. `setTimeout` and
 * `clearTimeout` are replaced before the catalog loads, so the release the catalog arms runs on the
 * virtual clock below instead of the real one.
 *
 * Every read path the catalog offers runs inside the first window, so data any of them derives from
 * the specs is live when the release fires. Reachability is counted over a WeakRef to every spec the
 * first parse yielded.
 *
 * Prints a {@link CatalogReachability}.
 */
import { getBundledModelReferenceIndex, resolveBundledModelReference } from "@veyyon/catalog/identity/bundled";
import {
	type GeneratedProvider,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	iterateBundledModelMetadata,
	readBundledModelKeys,
} from "@veyyon/catalog/models";

export interface CatalogReachability {
	/** Specs the first parse yielded. */
	specs: number;
	/** Distinct delays of the timers the catalog armed. */
	holdDelaysMs: number[];
	/** Specs reachable one millisecond before the window of the first read closes. */
	reachableBeforeWindowEnd: number;
	/** Specs reachable past the first read's window, with a second read inside it. */
	reachableAfterSlide: number;
	/** Specs reachable once the window of the last read closed. */
	reachableAfterRelease: number;
	/** Whether listing the providers after the release parsed the catalog again. */
	providerListParsed: boolean;
	/** Whether a parse after the release yields the same specs, compared as JSON. */
	reparsedEqual: boolean;
	/** The model a reference lookup resolves before and after the release. */
	referenceBefore: string | undefined;
	referenceAfter: string | undefined;
}

interface VirtualTimer {
	callback: () => void;
	due: number;
}

const HOLD_MS = Number(process.argv[2]);
const REFERENCE_ID = "claude-sonnet-4-5";

const realSetTimeout = globalThis.setTimeout;
let now = 0;
let armed = 0;
const delays = new Set<number>();
const pending = new Map<object, VirtualTimer>();
globalThis.setTimeout = ((callback: () => void, delayMs: number) => {
	armed++;
	delays.add(delayMs);
	const handle = { unref: () => handle, ref: () => handle, hasRef: () => false };
	pending.set(handle, { callback, due: now + delayMs });
	return handle;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((handle: object | undefined) => {
	if (handle) pending.delete(handle);
}) as typeof clearTimeout;

function advance(ms: number): void {
	now += ms;
	for (const [handle, timer] of [...pending]) {
		if (timer.due > now) continue;
		pending.delete(handle);
		timer.callback();
	}
}

/**
 * Collect from a shallow stack in a later task, then count the specs still reachable. The later task
 * ends the job that created the WeakRefs, which keeps their targets alive until it ends.
 */
async function reachable(refs: readonly WeakRef<object>[]): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	realSetTimeout(() => {
		Bun.gc(true);
		Bun.gc(true);
		let live = 0;
		for (const ref of refs) if (ref.deref() !== undefined) live++;
		resolve(live);
	}, 0);
	return promise;
}

function readEveryPath(): string | undefined {
	const reference = resolveBundledModelReference(REFERENCE_ID)?.id;
	const keys = readBundledModelKeys();
	keys.candidateAt(keys.ids.length - 1);
	for (const provider of getBundledProviders()) {
		const models = getBundledModels(provider as GeneratedProvider);
		const first = models[0];
		if (first) getBundledModel(provider as GeneratedProvider, first.id);
	}
	getBundledModelReferenceIndex();
	return reference;
}

function weakSpecs(): { refs: WeakRef<object>[]; serialized: string } {
	const specs = [...iterateBundledModelMetadata()];
	return { refs: specs.map(spec => new WeakRef(spec)), serialized: JSON.stringify(specs) };
}

const first = weakSpecs();
const referenceBefore = readEveryPath();

advance(HOLD_MS - 1);
const reachableBeforeWindowEnd = await reachable(first.refs);

// A read one millisecond before the window closes starts a new window.
iterateBundledModelMetadata().next();
advance(HOLD_MS - 1);
const reachableAfterSlide = await reachable(first.refs);

advance(1);
const reachableAfterRelease = await reachable(first.refs);

const armedBeforeList = armed;
getBundledProviders();
const providerListParsed = armed !== armedBeforeList;

const reparsedEqual = JSON.stringify([...iterateBundledModelMetadata()]) === first.serialized;
const referenceAfter = resolveBundledModelReference(REFERENCE_ID)?.id;

const result: CatalogReachability = {
	specs: first.refs.length,
	holdDelaysMs: [...delays],
	reachableBeforeWindowEnd,
	reachableAfterSlide,
	reachableAfterRelease,
	providerListParsed,
	reparsedEqual,
	referenceBefore,
	referenceAfter,
};
process.stdout.write(JSON.stringify(result));
