/**
 * Unit guard for the legacy pi-* specifier remap (`legacy-pi-compat.ts`).
 *
 * Both naming eras must resolve through the shim to the single in-process copy:
 *   - current `@veyyon/<name>` self-imports (after the `pi-*`→`*` package rename)
 *   - legacy `@mariozechner/pi-<name>` / `@earendil-works/pi-<name>` /
 *     `@oh-my-pi/pi-<name>` imports older third-party plugins published against
 *
 * Regression: the rename dropped `pi-` from the canonical package names and the
 * natives basename was briefly recorded as `veyyon-natives` — a name no plugin
 * ever imported — which both broke `@veyyon/natives` self-imports and stopped
 * matching the real legacy `pi-natives`. This asserts the corrected basename set
 * without loading the native addon or bundling an extension.
 */
import { describe, expect, it } from "bun:test";
import { __remapLegacyPiSpecifier } from "@veyyon/coding-agent/extensibility/plugins/legacy-pi-compat";

const CANONICAL_SCOPE = "@veyyon";
const LEGACY_SCOPES = ["@mariozechner", "@earendil-works", "@oh-my-pi", "@veyyon"] as const;

// basename => the canonical `@veyyon/<subpath>` the remap must produce.
const PACKAGES = [
	{ current: "agent-core", legacy: "pi-agent-core", canonical: "agent-core" },
	{ current: "ai", legacy: "pi-ai", canonical: "ai" },
	{ current: "coding-agent", legacy: "pi-coding-agent", canonical: "coding-agent" },
	{ current: "natives", legacy: "pi-natives", canonical: "natives" },
	{ current: "tui", legacy: "pi-tui", canonical: "tui" },
	{ current: "utils", legacy: "pi-utils", canonical: "utils" },
] as const;

describe("legacy pi-* specifier remap", () => {
	for (const pkg of PACKAGES) {
		it(`remaps the current @veyyon/${pkg.current} self-import through the shim`, () => {
			expect(__remapLegacyPiSpecifier(`@veyyon/${pkg.current}`)).toBe(`${CANONICAL_SCOPE}/${pkg.canonical}`);
		});

		for (const scope of LEGACY_SCOPES) {
			it(`remaps ${scope}/${pkg.legacy}`, () => {
				expect(__remapLegacyPiSpecifier(`${scope}/${pkg.legacy}`)).toBe(`${CANONICAL_SCOPE}/${pkg.legacy}`);
			});
		}
	}

	it("remaps the natives package under every alias scope (the veyyon-natives regression)", () => {
		expect(__remapLegacyPiSpecifier("@veyyon/natives")).toBe("@veyyon/natives");
		expect(__remapLegacyPiSpecifier("@mariozechner/pi-natives")).toBe("@veyyon/pi-natives");
		expect(__remapLegacyPiSpecifier("@oh-my-pi/pi-natives")).toBe("@veyyon/pi-natives");
		// The malformed name that no plugin ever published must NOT be treated as
		// a recognized alias.
		expect(__remapLegacyPiSpecifier("@oh-my-pi/veyyon-natives")).toBeNull();
	});

	it("preserves subpaths and applies the pi-ai/oauth remap", () => {
		expect(__remapLegacyPiSpecifier("@veyyon/coding-agent/extensibility/extensions")).toBe(
			"@veyyon/coding-agent/extensibility/extensions",
		);
		expect(__remapLegacyPiSpecifier("@mariozechner/pi-ai/oauth")).toBe("@veyyon/pi-ai/oauth");
		expect(__remapLegacyPiSpecifier("@mariozechner/pi-ai/utils/oauth")).toBe("@veyyon/pi-ai/oauth");
	});

	it("ignores unrelated scopes and packages", () => {
		expect(__remapLegacyPiSpecifier("@some-other/pi-ai")).toBeNull();
		expect(__remapLegacyPiSpecifier("@veyyon/not-a-bundled-package")).toBeNull();
		expect(__remapLegacyPiSpecifier("react")).toBeNull();
	});
});
