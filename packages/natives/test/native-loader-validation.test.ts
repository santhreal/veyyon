import { describe, expect, it } from "bun:test";
import { evaluateLoadedBindings, versionSentinelExportFor } from "../native/loader-state.js";

/**
 * Locks the RUNTIME load gate — the exact decision a user's "native addon
 * failed to load" crash hits. `evaluateLoadedBindings` is called right after
 * `dlopen` returns: it inspects the loaded addon for the version sentinel this
 * loader expects (`__veyyonNativesV<x_y_z>`) and decides accept / warn / throw.
 *
 * Why this suite exists: the shipped bug was a `.node` built for one version
 * loaded by a loader at another. The BUILD-side guard (`findStaleAddon`, see
 * native-embed-freshness.test.ts) catches it at publish; the pure sentinel
 * helpers (native-version-sentinel.test.ts) cover the string derivation. But
 * the gate that actually THREW in the user's terminal — the load-time
 * validation — had zero coverage, because in a workspace/CI load it takes the
 * boot-anyway branch and never fails, so no test ever exercised the throw. That
 * is the "tests never caught it" hole. These tests pin all three branches on
 * the pure decision so a refactor cannot silently invert the gate or make the
 * installed-user path fall back silently (Law 10).
 *
 * Sentinel strings are built via `versionSentinelExportFor`, never as raw
 * `"__veyyonNativesV…"` literals: the release bump rewrites such literals in
 * lock-step, which would clobber a fixture and redden this suite on every
 * release. A function call carries no literal for that rewrite to match.
 */

/** A loaded addon that exposes the sentinel for `builtVersion`, plus real native fns. */
function addonBuiltFor(builtVersion: string): Record<string, unknown> {
	return {
		grep: () => 0,
		ptyOpen: () => 0,
		[versionSentinelExportFor(builtVersion)]: () => 0,
	};
}

function ctxFor(opts: { packageVersion: string; isWorkspaceLoad: boolean }) {
	return {
		versionSentinelExport: versionSentinelExportFor(opts.packageVersion),
		isWorkspaceLoad: opts.isWorkspaceLoad,
		packageVersion: opts.packageVersion,
	};
}

describe("evaluateLoadedBindings — accept", () => {
	it("accepts an addon that exposes the exact sentinel this loader expects", () => {
		const ctx = ctxFor({ packageVersion: "1.0.15", isWorkspaceLoad: false });
		expect(evaluateLoadedBindings(ctx, addonBuiltFor("1.0.15"), "modern.node")).toEqual({ action: "accept" });
	});

	it("accepts regardless of workspace vs installed when the sentinel matches", () => {
		const bindings = addonBuiltFor("2.3.4");
		expect(evaluateLoadedBindings(ctxFor({ packageVersion: "2.3.4", isWorkspaceLoad: true }), bindings, "a.node")).toEqual({
			action: "accept",
		});
		expect(evaluateLoadedBindings(ctxFor({ packageVersion: "2.3.4", isWorkspaceLoad: false }), bindings, "a.node")).toEqual({
			action: "accept",
		});
	});
});

describe("evaluateLoadedBindings — installed/compiled load fails closed (the user's crash)", () => {
	it("throws when a `.node` built for a DIFFERENT version is loaded by an installed binary", () => {
		// The exact reported crash: modern.node built for 1.0.14, loader at 1.0.15,
		// not a workspace (an installed/compiled binary switching profiles). Must
		// fail closed, never boot on a wrong-ABI addon.
		const ctx = ctxFor({ packageVersion: "1.0.15", isWorkspaceLoad: false });
		const decision = evaluateLoadedBindings(ctx, addonBuiltFor("1.0.14"), "veyyon_natives.linux-x64-modern.node");
		expect(decision.action).toBe("throw");
		expect(decision.builtVersion).toBe("1.0.14");
	});

	it("names BOTH versions and the candidate path so the message is actionable", () => {
		// The original throw said only 'from a different release' without naming
		// which — a user could not tell what to rebuild/reinstall. It now reports
		// the built version, the expected version, and the offending file.
		const ctx = ctxFor({ packageVersion: "1.0.20", isWorkspaceLoad: false });
		const decision = evaluateLoadedBindings(ctx, addonBuiltFor("1.0.15"), "/opt/veyyon/native/1.0.20/veyyon_natives.linux-x64-modern.node");
		expect(decision.action).toBe("throw");
		expect(decision.message).toContain("@veyyon/natives@1.0.15"); // built for
		expect(decision.message).toContain("@veyyon/natives@1.0.20"); // loader expects
		expect(decision.message).toContain(versionSentinelExportFor("1.0.20"));
		expect(decision.message).toContain("/opt/veyyon/native/1.0.20/veyyon_natives.linux-x64-modern.node");
		expect(decision.message).toContain("reinstall");
	});

	it("throws with builtVersion 'unknown' when the addon carries NO sentinel at all", () => {
		// A pre-sentinel or corrupt addon exposes native fns but no version symbol.
		// Still fail closed on an installed load, and say the version is unknown
		// rather than pretend it matched.
		const ctx = ctxFor({ packageVersion: "1.0.20", isWorkspaceLoad: false });
		const decision = evaluateLoadedBindings(ctx, { grep: () => 0, ptyOpen: () => 0 }, "stale.node");
		expect(decision.action).toBe("throw");
		expect(decision.builtVersion).toBe("unknown");
		expect(decision.message).toContain("@veyyon/natives@unknown");
	});
});

describe("evaluateLoadedBindings — workspace load boots loudly, never silently (Law 10)", () => {
	it("warns (does not throw) for a stale native in a workspace/dev tree", () => {
		// A post-pull dev tree whose local `.node` predates the version bump: boot
		// anyway so work continues, but the decision must be 'warn', not silent
		// 'accept' — the silent skip here is exactly the Law-10 fallback that let
		// the stale native ship uncaught.
		const ctx = ctxFor({ packageVersion: "1.0.20", isWorkspaceLoad: true });
		const decision = evaluateLoadedBindings(ctx, addonBuiltFor("1.0.15"), "packages/natives/native/veyyon_natives.linux-x64-modern.node");
		expect(decision.action).toBe("warn");
		expect(decision.builtVersion).toBe("1.0.15");
	});

	it("the warning names the stale build, the tree version, the rebuild command, and the file", () => {
		const ctx = ctxFor({ packageVersion: "1.0.20", isWorkspaceLoad: true });
		const decision = evaluateLoadedBindings(ctx, addonBuiltFor("1.0.14"), "packages/natives/native/x.node");
		expect(decision.action).toBe("warn");
		expect(decision.message).toContain("@veyyon/natives@1.0.14");
		expect(decision.message).toContain("1.0.20");
		expect(decision.message).toContain("bun --cwd=packages/natives run build");
		expect(decision.message).toContain("packages/natives/native/x.node");
	});
});
