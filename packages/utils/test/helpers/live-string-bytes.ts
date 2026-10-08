import { setImmediate } from "node:timers/promises";

/** Fields per node of a JavaScriptCore heap snapshot: id, size, class name, flags. */
const NODE_FIELDS = 4;

/** A test runner's entry file: under `bun test`, `Bun.main` is the test file being run. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Snapshots per reading; the reading is the least of them. */
const SAMPLES = 3;

function stringBytesNow(): number {
	Bun.gc(true);
	const snapshot = Bun.generateHeapSnapshot();
	const string = snapshot.nodeClassNames.indexOf("string");
	let bytes = 0;
	for (let at = 0; at < snapshot.nodes.length; at += NODE_FIELDS) {
		if (snapshot.nodes[at + 2] === string) bytes += snapshot.nodes[at + 1]!;
	}
	return bytes;
}

/**
 * Bytes of every string cell the process heap holds after a full collection, characters included,
 * read from a JavaScriptCore heap snapshot. Taken on both sides of a step, the difference is what the
 * step left live. A string that slices another reports the bytes it keeps alive, so a slice of a large
 * text counts as that text.
 *
 * The collector scans the stack conservatively, so a string the program no longer references can
 * stay live until the frame slot that last held it is overwritten: a session's whole file text stayed
 * live past its open in one run of ten. Each snapshot is taken after a turn of the event loop, and the
 * reading is the least of `SAMPLES` of them, since a stale slot only ever adds to one.
 *
 * The snapshot reads the whole process, so it is taken only in a fresh process a test spawns, running
 * a fixture script: in a test runner process, strings the files run before it left behind die or stay
 * alive in the window, and moved a delta bounded by a 3.6 MB body by more than that body both ways.
 */
export async function liveStringBytes(): Promise<number> {
	if (TEST_FILE.test(Bun.main)) {
		throw new Error(
			`liveStringBytes reads the whole heap of ${Bun.main}, a test runner process; measure in a fixture script the test runs in a fresh process`,
		);
	}
	let least = Number.POSITIVE_INFINITY;
	for (let sample = 0; sample < SAMPLES; sample++) {
		await setImmediate();
		least = Math.min(least, stringBytesNow());
	}
	return least;
}
