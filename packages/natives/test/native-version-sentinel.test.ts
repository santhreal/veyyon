import { describe, expect, it } from "bun:test";
import {
	detectBuiltNativeVersion,
	nativeSentinelsInBuffer,
	repoSlugFromRepositoryUrl,
	versionSentinelExportFor,
} from "../native/loader-state.js";

/**
 * Locks the version<->native-sentinel contract and the release-download slug.
 *
 * Background: the native `.node` files are gitignored build artifacts. The
 * loader validates that a loaded addon exposes `__veyyonNativesV<version>`, but
 * that runtime check is SKIPPED in a workspace load (line: `if
 * (ctx.isWorkspaceLoad) return`) — which is exactly the environment the test
 * suite and CI run in. So nothing at runtime catches a package version bumped
 * without rebuilding the native. These unit tests pin the pure pieces of that
 * contract so a drift is caught in code, not only when a real user's install
 * crashes: the sentinel name derivation, the read-back of a built version, and
 * the download slug that must never point at a fork.
 */
describe("versionSentinelExportFor", () => {
	it("derives the exact export name the Rust addon emits for a version", () => {
		// The one that shipped stale: 1.0.14 loader vs a 1.0.13-built .node.
		expect(versionSentinelExportFor("1.0.14")).toBe("__veyyonNativesV1_0_16");
		expect(versionSentinelExportFor("1.0.13")).toBe("__veyyonNativesV1_0_16");
		expect(versionSentinelExportFor("16.5.2")).toBe("__veyyonNativesV1_0_16");
	});

	it("replaces every non-alphanumeric char, so prerelease/build tags stay a valid symbol", () => {
		expect(versionSentinelExportFor("1.0.0-rc.1")).toBe("__veyyonNativesV1_0_16");
		expect(versionSentinelExportFor("2.0.0+build.5")).toBe("__veyyonNativesV1_0_16");
	});

	it("round-trips with detectBuiltNativeVersion for a clean semver", () => {
		// The name the loader looks for, fed back through the reader, recovers the
		// version — so the "built for X, loader wants Y" warning reports true values.
		const bindings = { [versionSentinelExportFor("1.0.14")]: () => 0 };
		expect(detectBuiltNativeVersion(bindings)).toBe("1.0.14");
	});
});

describe("detectBuiltNativeVersion", () => {
	it("reads the built version back from a sentinel export among other bindings", () => {
		const bindings = { grep: () => 0, __veyyonNativesV1_0_16: () => 0, ptyOpen: () => 0 };
		expect(detectBuiltNativeVersion(bindings)).toBe("1.0.13");
	});

	it("returns 'unknown' when no version sentinel is present", () => {
		expect(detectBuiltNativeVersion({ grep: () => 0 })).toBe("unknown");
		expect(detectBuiltNativeVersion({})).toBe("unknown");
	});
});

describe("nativeSentinelsInBuffer", () => {
	// Simulate a compiled `.node`: arbitrary binary noise (including embedded NULs
	// and newlines, which break a naive line-based grep) with the exported symbol
	// name sitting somewhere inside it, exactly like the real ELF/Mach-O/PE symbol
	// table entry.
	function fakeAddon(...sentinels: string[]): Buffer {
		const noise = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x0a, 0xff, 0x00, 0x0a]);
		return Buffer.concat([noise, ...sentinels.flatMap(s => [Buffer.from(`\x00${s}\x00`, "latin1"), noise])]);
	}

	it("finds the exact sentinel a .node was built for, past embedded NULs and newlines", () => {
		expect(nativeSentinelsInBuffer(fakeAddon("__veyyonNativesV1_0_16"))).toEqual(["__veyyonNativesV1_0_16"]);
	});

	it("returns [] for a .node that carries no version sentinel at all", () => {
		expect(nativeSentinelsInBuffer(fakeAddon())).toEqual([]);
		expect(nativeSentinelsInBuffer(Buffer.from("not a native addon"))).toEqual([]);
	});

	it("deduplicates a sentinel that appears more than once", () => {
		const twice = Buffer.concat([fakeAddon("__veyyonNativesV1_0_16"), fakeAddon("__veyyonNativesV1_0_16")]);
		expect(nativeSentinelsInBuffer(twice)).toEqual(["__veyyonNativesV1_0_16"]);
	});

	it("surfaces the WRONG version a stale addon was built for, so the embed refusal can name it", () => {
		// The exact brick: a `modern.node` left at 1.0.14 while the package moved to
		// 1.0.15. The scanner reports 1.0.14; embed-native.ts sees the expected
		// 1.0.15 sentinel is absent and refuses to embed it.
		const stale = fakeAddon("__veyyonNativesV1_0_16");
		const sentinels = nativeSentinelsInBuffer(stale);
		expect(sentinels).toEqual(["__veyyonNativesV1_0_16"]);
		expect(sentinels).not.toContain(versionSentinelExportFor("1.0.15"));
	});

	it("accepts a matching addon, so a correctly-built variant is embedded", () => {
		const good = fakeAddon(versionSentinelExportFor("1.0.15"));
		expect(nativeSentinelsInBuffer(good)).toContain(versionSentinelExportFor("1.0.15"));
	});
});

describe("repoSlugFromRepositoryUrl", () => {
	it("parses owner/repo from the package.json git repository url", () => {
		expect(repoSlugFromRepositoryUrl("git+https://github.com/santhreal/veyyon.git")).toBe("santhreal/veyyon");
		expect(repoSlugFromRepositoryUrl("https://github.com/santhreal/veyyon")).toBe("santhreal/veyyon");
		expect(repoSlugFromRepositoryUrl("git@github.com:santhreal/veyyon.git")).toBe("santhreal/veyyon");
	});

	it("fails closed to veyyon's own slug for missing or unparseable input — never a fork", () => {
		// The whole point: the download help can never regress to pointing users at
		// an upstream/fork repo, even if repository.url is stripped or malformed.
		expect(repoSlugFromRepositoryUrl(undefined)).toBe("santhreal/veyyon");
		expect(repoSlugFromRepositoryUrl("")).toBe("santhreal/veyyon");
		expect(repoSlugFromRepositoryUrl("not a url")).toBe("santhreal/veyyon");
		expect(repoSlugFromRepositoryUrl("https://example.com/x/y")).toBe("santhreal/veyyon");
	});

	it("does not carry the upstream fork slug for any input", () => {
		for (const raw of [undefined, "", "garbage", "git+https://github.com/santhreal/veyyon.git"]) {
			expect(repoSlugFromRepositoryUrl(raw)).not.toContain("can1357");
			expect(repoSlugFromRepositoryUrl(raw)).not.toContain("oh-my-pi");
		}
	});
});
