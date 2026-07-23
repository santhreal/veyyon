/**
 * Locks the release version-sentinel rewrite to a SINGLE previous->new rename.
 *
 * Why this suite exists: releases published nothing for four versions
 * (1.0.13-1.0.16) because the bump step blanket-replaced every
 * `__veyyonNativesV…` literal with the current version. That clobbered the
 * fixtures in packages/natives/test/native-version-sentinel.test.ts —
 * `versionSentinelExportFor("1.0.14")` is pinned to `"__veyyonNativesV1_0_14"`,
 * a value that must NEVER track the release version — so the native test bucket
 * failed on every bump commit and the release_github job never ran. These tests
 * prove the rewrite plan targets only the previous release's sentinel and that
 * applying it leaves the historical fixtures intact, so the corruption cannot
 * come back.
 */
import { describe, expect, it } from "bun:test";
import { planSentinelRewrite, sentinelExportName } from "./release.ts";

describe("sentinelExportName", () => {
	it("maps a clean semver to its sentinel export symbol", () => {
		expect(sentinelExportName("1.0.17")).toBe("__veyyonNativesV1_0_17");
		expect(sentinelExportName("16.5.2")).toBe("__veyyonNativesV16_5_2");
	});

	it("tolerates a leading v and non-alphanumeric prerelease/build tags", () => {
		expect(sentinelExportName("v1.0.17")).toBe("__veyyonNativesV1_0_17");
		expect(sentinelExportName("1.0.0-rc.1")).toBe("__veyyonNativesV1_0_0_rc_1");
		expect(sentinelExportName("2.0.0+build.5")).toBe("__veyyonNativesV2_0_0_build_5");
	});
});

describe("planSentinelRewrite", () => {
	it("renames only the previous release's sentinel to the new one", () => {
		// The bump from the last published tag to the next patch.
		expect(planSentinelRewrite("v1.0.16", "1.0.17")).toEqual({
			from: "__veyyonNativesV1_0_16",
			to: "__veyyonNativesV1_0_17",
		});
	});

	it("does not target the historical fixtures the contract test pins", () => {
		// The from/to pair is the ONLY rename. It must never equal a fixture
		// sentinel, or applying it would rewrite that fixture.
		const { from, to } = planSentinelRewrite("v1.0.16", "1.0.17");
		for (const fixture of [
			"__veyyonNativesV1_0_13",
			"__veyyonNativesV1_0_14",
			"__veyyonNativesV16_5_2",
			"__veyyonNativesV2_0_0_build_5",
		]) {
			expect(from).not.toBe(fixture);
			expect(to).not.toBe(fixture);
		}
	});

	it("applied to the contract-test fixtures, leaves every old version fixture intact", () => {
		// Simulate exactly what `sd -F from to` does to the contract test file: a
		// literal replace of the previous sentinel. The historical fixtures must
		// survive byte-for-byte; only a current-version reference would move.
		const contractFixtures = [
			`expect(versionSentinelExportFor("1.0.14")).toBe("__veyyonNativesV1_0_14");`,
			`expect(versionSentinelExportFor("1.0.13")).toBe("__veyyonNativesV1_0_13");`,
			`expect(versionSentinelExportFor("16.5.2")).toBe("__veyyonNativesV16_5_2");`,
			`const bindings = { grep: () => 0, __veyyonNativesV1_0_13: () => 0, ptyOpen: () => 0 };`,
		].join("\n");

		const { from, to } = planSentinelRewrite("v1.0.16", "1.0.17");
		const rewritten = contractFixtures.replaceAll(from, to);

		// Nothing changed: the previous sentinel (V1_0_16) never appears in the
		// historical fixtures, so a scoped rename is a no-op here.
		expect(rewritten).toBe(contractFixtures);
		expect(rewritten).toContain(`.toBe("__veyyonNativesV1_0_14")`);
		expect(rewritten).toContain(`.toBe("__veyyonNativesV1_0_13")`);
		expect(rewritten).toContain(`.toBe("__veyyonNativesV16_5_2")`);
	});

	it("the OLD blanket rewrite WOULD have corrupted those fixtures (documents the bug)", () => {
		// The regression this suite guards against: a blanket
		// `sd '__veyyonNativesV[A-Za-z0-9_]+' <current>` rewrote every sentinel,
		// including the fixtures, to the current version.
		const fixture = `expect(versionSentinelExportFor("1.0.14")).toBe("__veyyonNativesV1_0_14");`;
		const blanketRewritten = fixture.replace(/__veyyonNativesV[A-Za-z0-9_]+/g, sentinelExportName("1.0.17"));
		// Both the input string AND the expected sentinel got clobbered — the exact
		// corruption that failed the native bucket.
		expect(blanketRewritten).toContain("__veyyonNativesV1_0_17");
		expect(blanketRewritten).not.toContain("__veyyonNativesV1_0_14");
	});
});
