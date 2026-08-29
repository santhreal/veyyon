import type { SpawnedWriteSample, SpawnedWriteSource } from "./write-accounting-helpers";
import { BYTES_PER_GB } from "./write-accounting-helpers";

export { sampleSpawnedWrites } from "./write-accounting-helpers";
export type { SpawnedWriteSource };
export { BYTES_PER_GB };

export class WriteAccountant {
	#harnessBytes = 0;
	#ioStatBytes = 0;
	readonly #procIoHighWater = new Map<number, number>();
	#source: SpawnedWriteSource = "none";

	recordHarnessWrite(bytes: number): void {
		if (!Number.isFinite(bytes) || bytes <= 0) return;
		this.#harnessBytes += bytes;
	}

	applySample(sample: SpawnedWriteSample): void {
		this.#source = sample.source;
		if (sample.source === "io.stat") {
			this.#ioStatBytes = Math.max(this.#ioStatBytes, sample.ioStatBytes ?? 0);
			return;
		}
		for (const entry of sample.procIo ?? []) {
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

export function formatWriteBytes(bytes: number): string {
	if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
