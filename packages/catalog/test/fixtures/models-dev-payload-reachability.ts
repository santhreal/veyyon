/**
 * Whether the models.dev payload stays reachable before and after the overlay's release fires.
 *
 * Run in a fresh process: in the test runner a promise another file left on the stack keeps the
 * payload reachable after the overlay has let go of it. `setTimeout` is replaced before the fetch so
 * the release the overlay arms is recorded instead of scheduled, and fired by hand.
 *
 * Prints `{ "releaseDelayMs": number, "reachableWhileHeld": boolean, "reachableAfterRelease": boolean }`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultModelsDevFallback } from "@veyyon/catalog/modelsdev-overlay";

export interface PayloadReachability {
	releaseDelayMs: number;
	reachableWhileHeld: boolean;
	reachableAfterRelease: boolean;
}

interface Armed {
	callback: () => void;
	delayMs: number;
}

const armed: Armed[] = [];
const scheduled = globalThis.setTimeout;
globalThis.setTimeout = ((callback: () => void, delayMs: number) => {
	const entry = { callback, delayMs };
	armed.push(entry);
	return { unref: () => entry, ref: () => entry, hasRef: () => false, refresh: () => entry };
}) as unknown as typeof setTimeout;
globalThis.fetch = (() => Promise.reject(new Error("no network expected"))) as unknown as typeof fetch;

/** End the current job so the WeakRef target is not kept for it, then collect. */
async function collect(): Promise<void> {
	await delay(0);
	Bun.gc(true);
	Bun.gc(true);
}

/** Fetch without keeping a strong reference in this frame. */
async function fetchWeakly(dbPath: string): Promise<WeakRef<object>> {
	const fallback = defaultModelsDevFallback("anthropic", dbPath);
	if (!fallback) throw new Error("anthropic has a models.dev descriptor");
	return new WeakRef((await fallback.fetch()) as object);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-modelsdev-reachability-"));
try {
	fs.writeFileSync(
		path.join(dir, "models-dev.json"),
		JSON.stringify({ fetchedAt: Date.now(), payload: { sentinel: "models-dev-payload" } }),
	);
	const ref = await fetchWeakly(path.join(dir, "models.db"));
	globalThis.setTimeout = scheduled;
	const release = armed.at(-1);
	if (!release) throw new Error("the overlay armed no release");

	await collect();
	const reachableWhileHeld = ref.deref() !== undefined;
	release.callback();
	await collect();
	const reachableAfterRelease = ref.deref() !== undefined;

	const result: PayloadReachability = { releaseDelayMs: release.delayMs, reachableWhileHeld, reachableAfterRelease };
	process.stdout.write(JSON.stringify(result));
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
