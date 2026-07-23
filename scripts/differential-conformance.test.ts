/**
 * Differential-gate self-test (TS-SUITE-7). The gate is only trustworthy if
 * it BOTH passes a faithful port and fails a diverging one — a gate that
 * cannot fail would wave a wrong Rust port through. Uses the protocol's
 * reference implementation (conformance-port-oracle.ts) as the faithful
 * port, and its --sabotage mode (one corrupted result) as the diverging one.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const GATE = join(REPO_ROOT, "scripts/differential-conformance.ts");
const ORACLE = join(REPO_ROOT, "scripts/conformance-port-oracle.ts");

function runGate(moduleName: string, ...portArgs: string[]): { code: number; out: string } {
	const proc = Bun.spawnSync(["bun", GATE, moduleName, "--", "bun", ORACLE, ...portArgs], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("differential conformance gate", () => {
	it("passes a faithful port on every hashline vector", () => {
		const { code, out } = runGate("hashline");
		expect(code).toBe(0);
		expect(out).toContain("port matches the oracle on all 153 vectors");
	});

	it("passes a faithful port on every mnemopi vector (incl. the NUL-tagged NaN protocol rule)", () => {
		const { code, out } = runGate("mnemopi");
		expect(code).toBe(0);
		expect(out).toContain("port matches the oracle on all 168 vectors");
	});

	it("fails a port with a single diverged result, naming the vector and both values", () => {
		const { code, out } = runGate("hashline", "--sabotage");
		expect(code).toBe(1);
		expect(out).toContain("differential failure(s) for hashline");
		expect(out).toContain("!DIVERGED");
		expect(out).toContain("oracle:");
		expect(out).toContain("port:");
	});
});
