/**
 * Non-TTY progress degradation: `\r`-rewriting progress lines only work on a
 * real terminal — a redirected stream collects thousands of repeated frames.
 * Commands that rewrite a progress line on a TTY use this printer on the
 * non-TTY branch: one plain line per key (file, stage, …) the first time it is
 * seen, then one line per `stepPercent` increase.
 */
export function makeCoarseStepPrinter(
	write: (line: string) => void,
	stepPercent = 25,
): (key: string, percent?: number) => void {
	const lastStep = new Map<string, number>();
	return (key, percent) => {
		const step = typeof percent === "number" ? Math.floor(percent / stepPercent) : -1;
		const prev = lastStep.get(key);
		if (prev !== undefined && step <= prev) return;
		lastStep.set(key, Math.max(step, prev ?? -1));
		write(step >= 0 ? `${key} (${step * stepPercent}%)` : key);
	};
}
