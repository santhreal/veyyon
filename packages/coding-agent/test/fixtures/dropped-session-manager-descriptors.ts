/**
 * Opens the session file argv[2], recorded under the session directory argv[3], through a
 * `FileSessionStorage`, drops the manager without closing it, and prints, as JSON, the descriptors
 * the process that runs this file holds on that file while the manager is live and once it is
 * collected. Linux only: descriptors are read from `/proc/self/fd`.
 */
import * as fs from "node:fs";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { postmortem } from "@veyyon/utils";

/** Full collections, each followed by a turn of the event loop, before the dropped count is read. */
const COLLECTION_ROUNDS = 50;

export interface DroppedDescriptors {
	/** Entries the manager loaded. */
	entries: number;
	/** Descriptors on the file while the manager is live. */
	whileOpen: number;
	/** Descriptors on the file once the manager is dropped and collected. */
	afterDrop: number;
}

function descriptorsOn(target: string): number {
	return fs.readdirSync("/proc/self/fd").filter(fd => {
		try {
			const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
			return link === target || link === `${target} (deleted)`;
		} catch {
			return false;
		}
	}).length;
}

/** Opens and counts in its own frame, so no local of the caller holds the manager. */
async function openLive(file: string, dir: string, target: string): Promise<Omit<DroppedDescriptors, "afterDrop">> {
	const manager = await SessionManager.open(file, dir, new FileSessionStorage(), { suppressBreadcrumb: true });
	return { entries: manager.getEntries().length, whileOpen: descriptorsOn(target) };
}

async function measure(file: string, dir: string): Promise<DroppedDescriptors> {
	const target = fs.realpathSync(file);
	const live = await openLive(file, dir, target);
	for (let round = 0; round < COLLECTION_ROUNDS && descriptorsOn(target) > 0; round++) {
		Bun.gc(true);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	return { ...live, afterDrop: descriptorsOn(target) };
}

try {
	const [file, dir] = process.argv.slice(2);
	if (!file || !dir) throw new Error("usage: dropped-session-manager-descriptors.ts <session-file> <session-dir>");
	process.stdout.write(`${JSON.stringify(await measure(file, dir))}\n`);
} finally {
	await postmortem.cleanup();
}
