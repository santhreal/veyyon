/** Fields per node of a JavaScriptCore heap snapshot: id, size, class name, flags. */
const NODE_FIELDS = 4;

/**
 * Bytes of every string cell the process heap holds after a full collection, characters included,
 * read from a JavaScriptCore heap snapshot. Taken on both sides of a step, the difference is what the
 * step left live. A string that slices another reports the bytes it keeps alive, so a slice of a large
 * text counts as that text. The snapshot walks the whole heap: about 100 ms in a process running one
 * file, and seconds when the file shares a process with a package's suite.
 */
export function liveStringBytes(): number {
	Bun.gc(true);
	const snapshot = Bun.generateHeapSnapshot();
	const string = snapshot.nodeClassNames.indexOf("string");
	let bytes = 0;
	for (let at = 0; at < snapshot.nodes.length; at += NODE_FIELDS) {
		if (snapshot.nodes[at + 2] === string) bytes += snapshot.nodes[at + 1]!;
	}
	return bytes;
}
