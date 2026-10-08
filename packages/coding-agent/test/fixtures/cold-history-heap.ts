/**
 * Opens the session file argv[2], recorded under the session directory argv[3], through a
 * `FileSessionStorage` that counts reads through its pinned readers, and prints, as JSON, the heap
 * the open retains, the most heap it retained at any turn of the event loop while it ran, what a
 * context build sends and how many reads it made, and the heap once a walk has read the content of
 * every tool result back.
 *
 * Runs in its own process, so nothing writing the session left behind reaches either measurement:
 * the publish that writes it reads the whole file back, and a promise rooted outside the heap holds
 * that text across full collections for a time that varies from run to run.
 */
import { heapStats } from "bun:jsc";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage, type PinnedSessionReader } from "@veyyon/kernel/session/session-storage";
import { postmortem } from "@veyyon/utils";

export interface ColdHistoryHeap {
	/** Heap and external bytes the open retains over the heap before it. */
	cold: number;
	/**
	 * The most heap and external bytes retained over the heap before the open, after a full
	 * collection at each turn of the event loop while the open ran. A streamed load yields a turn
	 * after each read of the file.
	 */
	loadPeak: number;
	/** Turns of the event loop {@link loadPeak} sampled. */
	loadSamples: number;
	/** The messages a context build sends, as JSON. */
	context: string;
	/** Reads through the pinned readers once the open and the context build return. */
	readsAfterContext: number;
	/** Tool result messages whose content the walk read. */
	results: number;
	/** Heap and external bytes retained once the walk returns, over the heap before the open. */
	warm: number;
}

class CountingStorage extends FileSessionStorage {
	reads = 0;

	openPinnedReaderSync(filePath: string): PinnedSessionReader | undefined {
		const inner = super.openPinnedReaderSync(filePath);
		if (inner === undefined) return undefined;
		return {
			identity: inner.identity,
			read: (offset, length) => {
				this.reads += 1;
				return inner.read(offset, length);
			},
			close: () => inner.close(),
		};
	}
}

function retained(): number {
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

async function measure(file: string, dir: string): Promise<ColdHistoryHeap> {
	const before = retained();
	const storage = new CountingStorage();
	let opening = true;
	let loadPeak = 0;
	let loadSamples = 0;
	const sample = (): void => {
		if (!opening) return;
		loadSamples += 1;
		loadPeak = Math.max(loadPeak, retained() - before);
		setImmediate(sample);
	};
	setImmediate(sample);
	const manager = await SessionManager.open(file, dir, storage, { suppressBreadcrumb: true });
	opening = false;
	const cold = retained() - before;
	const context = JSON.stringify(manager.buildSessionContext().messages);
	const readsAfterContext = storage.reads;
	let results = 0;
	for (const entry of manager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.content.length > 0) {
			results += 1;
		}
	}
	const warm = retained() - before;
	await manager.close();
	return { cold, loadPeak, loadSamples, context, readsAfterContext, results, warm };
}

try {
	const [file, dir] = process.argv.slice(2);
	if (!file || !dir) throw new Error("usage: cold-history-heap.ts <session-file> <session-dir>");
	process.stdout.write(`${JSON.stringify(await measure(file, dir))}\n`);
} finally {
	await postmortem.cleanup();
}
