const kSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	if ("sleepSync" in Bun && typeof Bun.sleepSync === "function") {
		Bun.sleepSync(ms);
		return;
	}
	Atomics.wait(kSleepBuffer, 0, 0, ms);
}
