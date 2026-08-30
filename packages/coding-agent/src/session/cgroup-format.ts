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

import { BYTES_PER_GB } from "./write-accounting";

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

/** The two control files a memory cap writes, as one value. */
export interface MemoryCapControls {
	/** `memory.max`: the resident ceiling, or `"max"` for no cap. */
	max: string;
	/** `memory.swap.max`: 0 under a cap, `"max"` when there is none. */
	swapMax: string;
}

/**
 * The `memory.max` and `memory.swap.max` pair for a cap of `limitGb`
 * gigabytes, returned together so a caller cannot write one without the other.
 *
 * `memory.max` on its own is not a memory ceiling on a host with swap. It caps
 * RESIDENT memory: at the limit the kernel reclaims and pushes anonymous pages
 * to swap, so a process allocating past the cap keeps running and the machine
 * starts swapping, which is the outcome both memory settings exist to prevent.
 * Measured on a 91 GB host with 8 GB of swap, a group capped at 256 MB reached
 * 5,520 MB of allocation, hit `memory.max` 24,431 times and pushed 2.9 GB into
 * swap before the kernel OOM-killed it — 21 times the cap, after the swap storm
 * the cap was set to avoid.
 *
 * Pinning `memory.swap.max` to 0 for a capped group makes the limit what the
 * settings row says it is, the total anonymous footprint the tree may hold, and
 * makes the OOM kill prompt. A group with no cap gets `"max"`, so lifting a
 * limit restores the kernel default instead of leaving the group unable to swap.
 */
export function memoryCapControls(limitGb: number): MemoryCapControls {
	return { max: formatLimitFileValue(limitGb, BYTES_PER_GB), swapMax: limitGb > 0 ? "0" : "max" };
}
