/**
 * Property checks for the two pure conversions the CPU budget rest on:
 * `formatCpuMaxValue` (Linux `cpu.max` bytes) and `sessionCpuBudgetName`
 * (the native spawn-hook key). Grid/unit cases for the same functions live
 * in cpu-limit.test.ts; this file is the exhaustive grid.
 */

import { describe, expect, it } from "bun:test";
import { CGROUP_CPU_PERIOD_USEC, formatCpuMaxValue, formatSystemdCpuQuota } from "../src/session/cgroup-format";
import { sessionCpuBudgetName } from "../src/session/cpu-limit";

describe("formatCpuMaxValue property", () => {
	it("never writes a freeze quota for any IEEE input", () => {
		const inputs = [
			0,
			-0,
			-1,
			-1e9,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.MIN_VALUE,
			Number.EPSILON,
			1e-20,
			1e-12,
			1e-10,
			4e-6,
			5e-6,
			1e-5,
			0.000004,
			0.000005,
			0.155,
			0.29,
			1 / 3,
			2 / 3,
			0.5,
			1,
			2,
			16,
			64,
			1e6,
		];
		for (let step = -20; step <= 80; step++) {
			inputs.push(step / 10);
			inputs.push(10 ** (step / 20 - 8));
		}
		for (const cores of inputs) {
			const line = formatCpuMaxValue(cores);
			const [quota, period] = line.split(" ");
			expect(period).toBe(String(CGROUP_CPU_PERIOD_USEC));
			if (!Number.isFinite(cores) || cores <= 0) {
				expect(line).toBe(`max ${CGROUP_CPU_PERIOD_USEC}`);
			} else {
				expect(quota).not.toBe("max");
				expect(quota).not.toBe("0");
				const n = Number(quota);
				expect(Number.isInteger(n)).toBe(true);
				expect(n).toBeGreaterThanOrEqual(1);
				expect(n).toBe(Math.max(1, Math.round(cores * CGROUP_CPU_PERIOD_USEC)));
			}
		}
	});

	it("is monotonic in cores across a dense positive grid", () => {
		let previous = 0;
		for (let step = 1; step <= 10_000; step++) {
			const cores = step / 1_000;
			const quota = Number(formatCpuMaxValue(cores).split(" ")[0]);
			expect(quota).toBeGreaterThanOrEqual(previous);
			previous = quota;
		}
	});
});

describe("sessionCpuBudgetName property", () => {
	it("is a non-empty veyyon-cpu- name of cgroup-safe characters", () => {
		const ids = [
			"",
			" ",
			"///",
			"...",
			"sess-test",
			"Sess_TEST-1",
			"hello world",
			"a/b",
			"a\\b",
			"ünicode",
			"a".repeat(200),
			"..",
			"-",
			"_",
			"0",
			"foo.bar",
			"foo@bar",
			"session id\nwith\nnewlines",
		];
		for (let i = 0; i < 200; i++) {
			ids.push(`id ${i} / ${String.fromCharCode(32 + (i % 95))}`);
		}
		for (const id of ids) {
			const name = sessionCpuBudgetName(id);
			expect(name.startsWith("veyyon-cpu-")).toBe(true);
			expect(name.length).toBeGreaterThan("veyyon-cpu-".length);
			expect(name.slice("veyyon-cpu-".length)).toMatch(/^[a-zA-Z0-9_-]+$/);
			expect(name.includes("/")).toBe(false);
			expect(name.includes(".")).toBe(false);
		}
	});

	it("is injective on already-safe ids and maps empty to session", () => {
		expect(sessionCpuBudgetName("")).toBe("veyyon-cpu-session");
		// Only a fully-stripped id becomes "session". Punctuation survives as dashes.
		expect(sessionCpuBudgetName("@@@")).toBe("veyyon-cpu----");
		expect(sessionCpuBudgetName("...")).toBe("veyyon-cpu----");
		const seen = new Map<string, string>();
		for (let i = 0; i < 500; i++) {
			const id = `sess_${i}-ok`;
			const name = sessionCpuBudgetName(id);
			expect(seen.has(name)).toBe(false);
			seen.set(name, id);
			expect(sessionCpuBudgetName(id)).toBe(name);
		}
	});
});

describe("formatSystemdCpuQuota property", () => {
	it("never writes 0% or scientific notation for any IEEE input", () => {
		const inputs = [
			0,
			-0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			1e-20,
			1e-12,
			1e-6,
			4e-6,
			0.001,
			0.5,
			1,
			2,
			16,
			128,
		];
		for (let step = -20; step <= 400; step++) {
			inputs.push(10 ** (step / 20));
			inputs.push(-(10 ** (step / 20)));
			inputs.push(step / 1000);
		}
		for (const cores of inputs) {
			const value = formatSystemdCpuQuota(cores);
			if (!Number.isFinite(cores) || cores <= 0) {
				expect(value, String(cores)).toBeUndefined();
				continue;
			}
			expect(value, String(cores)).toBeDefined();
			expect(value, String(cores)).not.toBe("CPUQuota=0%");
			expect(value, String(cores)).not.toMatch(/e/i);
			expect(value, String(cores)).toMatch(/^CPUQuota=\d+(\.\d+)?%$/);
		}
	});
});
