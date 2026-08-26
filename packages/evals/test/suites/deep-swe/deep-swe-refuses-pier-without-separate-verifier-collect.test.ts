/**
 * WHY THIS SUITE EXISTS. DeepSWE v1.1 grades in a separate verifier and depends
 * on Pier's collect hook to move the agent's committed patch into that verifier.
 * Pier 0.3.0 silently skipped the hook: agents completed and committed thousands
 * of lines, then every trial received reward zero because the verifier saw no
 * patch. This closes the version-boundary class; it does not test Pier's own hook
 * implementation, which the zero-quota Oracle probe covers before paid runs.
 */
import { describe, expect, it } from "bun:test";
import { pierSupportsSeparateVerifierCollect } from "../../../src/backends/pier/version";

describe("DeepSWE Pier compatibility", () => {
	it.each([
		["0.2.99", false],
		["0.3.0", false],
		["datacurve-pier 0.3.0\n", false],
		["0.3.1", true],
		["pier v0.3.1", true],
		["0.3.2", true],
		["0.4.0", true],
		["1.0.0", true],
		["unknown", false],
		["", false],
	] as const)("classifies %j as supported=%s", (version, supported) => {
		expect(pierSupportsSeparateVerifierCollect(version)).toBe(supported);
	});
});
