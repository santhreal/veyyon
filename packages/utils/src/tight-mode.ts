/**
 * The one process-wide layout knob: whether surfaces render one column tighter.
 *
 * A module-level flag rather than a parameter because every component reads it and
 * none of them sets it — the session sets it once at startup from configuration.
 */

let globalTight = false;

export function setTuiTight(tight: boolean): void {
	globalTight = tight;
}

export function isTuiTight(): boolean {
	return globalTight;
}

export function getPaddingX(basePadding: number): number {
	return globalTight ? Math.max(0, basePadding - 1) : basePadding;
}
