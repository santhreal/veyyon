import type { QueuedTrial } from "../aggregate";

export interface PairedWaveSchedulerOptions {
	armsPerWave: number;
	run(trial: QueuedTrial): Promise<void>;
	shouldStop(): boolean;
}

/**
 * Drain a task-major queue one complete arm set at a time.
 *
 * Every arm for one (task, repeat) cell starts together. The next cell does not
 * start until the full wave settles, so provider load and cache state stay paired
 * and one faster arm can never run ahead of its counterpart.
 */
export async function drainTrialQueueInPairedWaves(
	queue: QueuedTrial[],
	options: PairedWaveSchedulerOptions,
): Promise<void> {
	if (!Number.isInteger(options.armsPerWave) || options.armsPerWave < 1) {
		throw new Error(`armsPerWave must be a positive integer, got ${options.armsPerWave}`);
	}
	while (!options.shouldStop()) {
		const wave = queue.splice(0, options.armsPerWave);
		if (wave.length === 0) return;
		const first = wave[0]!;
		const distinctArms = new Set(wave.map(trial => trial.arm));
		if (
			wave.length !== options.armsPerWave ||
			distinctArms.size !== options.armsPerWave ||
			wave.some(trial => trial.task !== first.task || trial.repeat !== first.repeat)
		) {
			throw new Error(
				`paired wave is not one complete arm set for ${first.task} repeat ${first.repeat}: ` +
					wave.map(trial => `${trial.arm}/${trial.task}/r${trial.repeat}`).join(", "),
			);
		}
		await Promise.all(wave.map(options.run));
	}
}
