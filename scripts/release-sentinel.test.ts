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
import { classifySentinelBumpState, isSentinelRewriteExcluded, planSentinelRewrite, sentinelExportName } from "./release.ts";

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
});

describe("isSentinelRewriteExcluded — the file scope of the rewrite", () => {
	it("excludes test files, which carry the sentinel as an intentional fixture", () => {
		// The v1.0.19 recurrence: native-embed-freshness.test.ts held the literal
		// "__veyyonNativesV1_0_18" as a fixture. 1.0.18 was the PREVIOUS release, so
		// the rewrite's `from` equaled that literal and clobbered it to 1_0_19,
		// failing the native bucket and blocking the publish. Test files must be
		// excluded from the file scan no matter what version they reference.
		for (const testFile of [
			"packages/natives/test/native-embed-freshness.test.ts",
			"packages/natives/test/native-version-sentinel.test.ts",
			"packages/coding-agent/test/foo.test.mts",
			"packages/tui/test/bar.test.js",
		]) {
			expect(isSentinelRewriteExcluded(testFile)).toBe(true);
		}
	});

	it("excludes vendored and build-output copies", () => {
		expect(isSentinelRewriteExcluded("packages/natives/node_modules/x/lib.js")).toBe(true);
		expect(isSentinelRewriteExcluded("packages/coding-agent/dist/cli.js")).toBe(true);
	});

	it("still rewrites production source that emits or mirrors the current sentinel", () => {
		// These are NOT test files and must advance on a bump: the Rust js_name, the
		// generated native mirrors, and the render-stress harness (a `-harness.ts`,
		// not a `.test.ts`, so the `.test.` convention keeps it in scope).
		for (const productionFile of [
			"crates/veyyon-natives/src/lib.rs",
			"packages/natives/native/index.js",
			"packages/natives/native/index.d.ts",
			"packages/tui/test/render-stress-harness.ts",
			"packages/tui/test/render-stress-subprocess.ts",
		]) {
			expect(isSentinelRewriteExcluded(productionFile)).toBe(false);
		}
	});

	it("documents the bug that the exclusion now prevents (superseded assertion)", () => {
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

describe("classifySentinelBumpState — re-cut tolerance after a dead tag", () => {
	// Why this suite exists: the v1.0.37 tag was cut (bump commit landed on
	// main) but its publish died and the tag was deleted. The next cut targeted
	// the SAME version, found lib.rs already emitting the new sentinel, and the
	// old must-hold-the-previous-sentinel check wedged the entire release train
	// (2026-07-24, run 30076034379). These tests lock the three-way
	// classification that lets a re-cut proceed while still refusing a
	// genuinely inconsistent tree.
	const prev = "__veyyonNativesV1_0_36";
	const next = "__veyyonNativesV1_0_37";

	it("classifies an ordinary cut (lib.rs still emits the previous sentinel) as rewrite", () => {
		const libRs = `#[napi(js_name = "${prev}")]\npub fn version_sentinel() {}\n`;
		expect(classifySentinelBumpState(libRs, prev, next)).toBe("rewrite");
	});

	it("classifies a dead-tag re-cut (lib.rs already emits the new sentinel) as alreadyBumped", () => {
		// The exact v1.0.37 state: a prior cut of the same version already
		// renamed the sentinel; the tree is correct and the cut must proceed.
		const libRs = `#[napi(js_name = "${next}")]\npub fn version_sentinel() {}\n`;
		expect(classifySentinelBumpState(libRs, prev, next)).toBe("alreadyBumped");
	});

	it("classifies a tree with neither sentinel as missing (the cut must refuse)", () => {
		const libRs = `#[napi(js_name = "__veyyonNativesV1_0_30")]\npub fn version_sentinel() {}\n`;
		expect(classifySentinelBumpState(libRs, prev, next)).toBe("missing");
	});

	it("requires the sentinel as a js_name emission, not a stray literal", () => {
		// A comment or fixture mentioning the new sentinel must not read as
		// alreadyBumped: only the actual `js_name = "…"` emission counts.
		const libRs = `// history: ${next} ships next\n#[napi(js_name = "${prev}")]\npub fn version_sentinel() {}\n`;
		expect(classifySentinelBumpState(libRs, prev, next)).toBe("rewrite");
		const strayOnly = `// mentions ${next} in prose only\n`;
		expect(classifySentinelBumpState(strayOnly, prev, next)).toBe("missing");
	});
});
