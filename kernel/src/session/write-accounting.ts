/**
 * Cumulative disk-write accounting for a session budget group.
 *
 * TWO SOURCES, ONE TOTAL. A session tree writes to disk from two places that
 * no single counter sees:
 *
 * 1. PROCESSES IN THE GROUP. Bash commands, the interactive PTY, MCP stdio
 *    servers, launch tasks, eval kernels. These are inside the budget group,
 *    so the OS meters them.
 * 2. THE HARNESS ITSELF. The `write` and `edit` tools run in the veyyon
 *    process, which is deliberately NOT in the budget group (see
 *    cpu-limit.ts), so no group counter will ever see a byte of it. Those
 *    tools report their byte counts here instead.
 *
 * Both land in one total per group, because the operator set one budget.
 *
 * WHY TWO SPAWNED SOURCES, AND WHY io.stat IS NOT ENOUGH. cgroup v2 meters
 * block-layer writes per group in `io.stat` (`wbytes=`, one entry per
 * device), which is the cheapest and most complete reading when it exists.
 * It usually does not: systemd delegates `cpu memory pids` to a user session
 * and NOT `io`, and `systemd-run --user` cannot add it, so on an ordinary
 * Linux desktop the session cgroup has no `io.stat` at all. Reading it and
 * believing the absence would meter every such host at zero forever. The
 * fallback sums `write_bytes` from `/proc/<pid>/io` over the group's members.
 * That is per-process and disappears when a process exits, so the sampler
 * keeps a per-pid HIGH-WATER MARK: bytes written by a command that has since
 * finished stay counted, which is the whole point of a cumulative budget.
 *
 * The source is probed by READING, never assumed from the platform or from
 * which controllers were delegated, and the group reports which one it is
 * using so a host with neither can say so instead of pretending.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";

/** Bytes in one gigabyte, the unit `session.writeBudgetGb` is expressed in. */
export const BYTES_PER_GB = 1024 ** 3;

/** Where a group's spawned-process write bytes are being read from. */
export type SpawnedWriteSource = "io.stat" | "proc-io" | "none";

/**
 * Sum `wbytes=` across every device line of a cgroup v2 `io.stat`. Undefined
 * when the file carries no `wbytes` at all, which is how "this controller is
 * not really reporting" is told apart from "nothing has been written yet".
 */
export function parseIoStatWrittenBytes(text: string): number | undefined {
	let total: number | undefined;
	for (const line of text.split("\n")) {
		for (const field of line.trim().split(/\s+/)) {
			const separator = field.indexOf("=");
			if (separator < 0 || field.slice(0, separator) !== "wbytes") continue;
			const bytes = Number.parseInt(field.slice(separator + 1), 10);
			if (!Number.isFinite(bytes) || bytes < 0) continue;
			total = (total ?? 0) + bytes;
		}
	}
	return total;
}

/**
 * `write_bytes` from a `/proc/<pid>/io`.
 *
 * `write_bytes`, not `wchar`: wchar counts bytes handed to `write(2)`,
 * including the ones the page cache absorbs and never stores, so a program
 * that rewrites the same page in a loop would burn a disk budget it never
 * spent. A disk budget means storage reached, which is what `write_bytes`
 * counts.
 */
export function parseProcIoWrittenBytes(text: string): number | undefined {
	for (const line of text.split("\n")) {
		if (!line.startsWith("write_bytes:")) continue;
		const bytes = Number.parseInt(line.slice("write_bytes:".length).trim(), 10);
		return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
	}
	return undefined;
}

/** One reading of the spawned half of a group's writes. */
export interface SpawnedWriteSample {
	source: SpawnedWriteSource;
	/** Cumulative group total, when `source` is `io.stat`. */
	ioStatBytes?: number;
	/** Per-process cumulative totals, when `source` is `proc-io`. */
	procIo?: Array<{ pid: number; bytes: number }>;
}

async function readOptionalFile(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		// EACCES on another user's /proc entry, EIO on a wedged controller: an
		// unreadable source is an absent source, never a thrown poll.
		return undefined;
	}
}

/**
 * Read the group's spawned-process writes, preferring `io.stat` and falling
 * back to `/proc/<pid>/io` over the live members. Probes by reading: a
 * `cgroupDir` whose `io.stat` is missing (the `io` controller was not
 * delegated) drops to the fallback rather than reporting zero.
 */
export async function sampleSpawnedWrites(options: {
	cgroupDir: string | undefined;
	procRoot: string;
	members: number[];
}): Promise<SpawnedWriteSample> {
	if (options.cgroupDir) {
		const text = await readOptionalFile(path.join(options.cgroupDir, "io.stat"));
		const ioStatBytes = text === undefined ? undefined : parseIoStatWrittenBytes(text);
		if (ioStatBytes !== undefined) return { source: "io.stat", ioStatBytes };
	}
	const procIo: Array<{ pid: number; bytes: number }> = [];
	for (const pid of options.members) {
		const text = await readOptionalFile(path.join(options.procRoot, String(pid), "io"));
		if (text === undefined) continue;
		const bytes = parseProcIoWrittenBytes(text);
		if (bytes !== undefined) procIo.push({ pid, bytes });
	}
	// An empty group on a host WITH procfs is not the same as a host without
	// it, but neither has produced a byte yet and both read as `proc-io` the
	// moment a member appears. `none` is reserved for a group that cannot ever
	// meter its spawned half: no cgroup dir and no readable /proc.
	if (procIo.length > 0) return { source: "proc-io", procIo };
	const procRootReadable = await readOptionalFile(path.join(options.procRoot, "self", "io"));
	return procRootReadable === undefined ? { source: "none" } : { source: "proc-io", procIo };
}

/**
 * The cumulative byte total one budget group is judged against: harness tool
 * writes plus whichever spawned source the host can actually read.
 */
export class WriteAccountant {
	#harnessBytes = 0;
	#ioStatBytes = 0;
	readonly #procIoHighWater = new Map<number, number>();
	#source: SpawnedWriteSource = "none";

	/** Bytes veyyon's own tools wrote; the harness is never in the group. */
	recordHarnessWrite(bytes: number): void {
		if (!Number.isFinite(bytes) || bytes <= 0) return;
		this.#harnessBytes += bytes;
	}

	/** Fold one spawned-side sample in, replacing the source it came from. */
	applySample(sample: SpawnedWriteSample): void {
		this.#source = sample.source;
		if (sample.source === "io.stat") {
			// A cumulative kernel counter: take it, never add to it.
			this.#ioStatBytes = Math.max(this.#ioStatBytes, sample.ioStatBytes ?? 0);
			return;
		}
		for (const entry of sample.procIo ?? []) {
			// High-water, so a finished command's bytes survive its exit. A
			// per-process counter only ever rises, so a lower reading means a
			// recycled pid, and keeping the larger number is the safe side of a
			// budget.
			const previous = this.#procIoHighWater.get(entry.pid) ?? 0;
			if (entry.bytes > previous) this.#procIoHighWater.set(entry.pid, entry.bytes);
		}
	}

	get source(): SpawnedWriteSource {
		return this.#source;
	}

	get harnessBytes(): number {
		return this.#harnessBytes;
	}

	get spawnedBytes(): number {
		if (this.#source === "io.stat") return this.#ioStatBytes;
		let total = 0;
		for (const bytes of this.#procIoHighWater.values()) total += bytes;
		return total;
	}

	get totalBytes(): number {
		return this.#harnessBytes + this.spawnedBytes;
	}
}

/** Bytes as an operator-facing size, in the unit the number is legible at. */
export function formatWriteBytes(bytes: number): string {
	if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
