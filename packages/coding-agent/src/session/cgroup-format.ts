/**
 * The single owner of the byte-level formats veyyon writes into cgroup v2
 * control files, and of the systemd quota string that stands in for `cpu.max`
 * when the harness cannot write a cgroup itself.
 *
 * Two tiers write these files — the machine group in `machine-budget.ts` and
 * the session groups nested inside it in `cpu-limit.ts` — and the session tier
 * imports the machine tier, so a formatter kept in either one is either
 * duplicated or a cycle. It was duplicated, and the copies disagreed: one
 * rounded the quota and floored it at a microsecond, the other truncated, so a
 * positive machine budget below half a microsecond of the period wrote
 * `0 100000`. That is not a small cap. `cpu.max` reads a zero quota as a
 * freeze, so the tier that was meant to bound the machine would have stopped
 * every process on it instead.
 *
 * A format written by two tiers has one definition here, so the tiers cannot
 * disagree about what a limit means.
 */

/** cgroup v2 `cpu.max` period every quota here is expressed against (microseconds). */
export const CGROUP_CPU_PERIOD_USEC = 100_000;

/**
 * The `cpu.max` line for `cores` cores: `"<quota> <period>"`, or `"max
 * <period>"` for no cap.
 *
 * A positive budget that rounds to 0 µs is a freeze (`0 100000`), the same trap
 * as writing a zero quota at `cores === 0`. It floors at 1 µs instead: the
 * smallest cap `cpu.max` can express, matching a Windows `CpuRate` of 1 for a
 * tiny-but-nonzero budget.
 */
export function formatCpuMaxValue(cores: number): string {
	if (!Number.isFinite(cores) || cores <= 0) return `max ${CGROUP_CPU_PERIOD_USEC}`;
	const quota = Math.max(1, Math.round(cores * CGROUP_CPU_PERIOD_USEC));
	return `${quota} ${CGROUP_CPU_PERIOD_USEC}`;
}

/**
 * systemd `CPUQuota=` for `cores` cores. systemd rejects `CPUQuota=0%` and
 * scientific notation (`1e-10%`); a positive budget that would print as either
 * floors at 0.001% — one microsecond of a 100ms period, the same 1 µs floor as
 * {@link formatCpuMaxValue}.
 */
export function formatSystemdCpuQuota(cores: number): string | undefined {
	if (!Number.isFinite(cores) || cores <= 0) return undefined;
	// JS Number.toString uses scientific notation at 1e21. systemd rejects that.
	const percent = Math.min(1e18, Math.max(0.001, cores * 100));
	const rendered = Number.isInteger(percent)
		? String(percent)
		: percent
				.toFixed(6)
				.replace(/\.0+$/, "")
				.replace(/(\.\d*?)0+$/, "$1");
	return `CPUQuota=${rendered}%`;
}

/**
 * The value for a countable cgroup limit — `pids.max`, `memory.max` — or the
 * kernel's `"max"` for no cap. `scale` converts the setting's unit to the
 * file's, such as bytes per gigabyte for `memory.max`.
 *
 * These files take a whole count and reject a fraction, so the scaled value
 * truncates. Unlike `cpu.max` there is no freeze to avoid: a positive limit
 * that truncates to 0 is a real refusal of that resource, which is what a
 * budget too small to satisfy should do.
 */
export function formatLimitFileValue(value: number, scale = 1): string {
	return value > 0 ? String(Math.floor(value * scale)) : "max";
}
