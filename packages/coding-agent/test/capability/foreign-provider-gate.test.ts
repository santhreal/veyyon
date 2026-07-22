import { describe, expect, it } from "bun:test";
import { FOREIGN_PROVIDER_IDS, getForeignProviderIds } from "@veyyon/coding-agent/capability";

/**
 * FOREIGN_PROVIDER_IDS is the exact set of discovery providers gated behind
 * `discovery.importForeignConfig` (default OFF): providers that would ambiently pick up configuration
 * authored for OTHER AI tools (a foreign CLAUDE.md/GEMINI.md, cursor/windsurf/codex rules, their MCP
 * servers). veyyon deliberately ignores those unless the user opts in. This list IS that policy, so it
 * gets a direct contract test: dropping an entry would silently start importing that tool's config by
 * default (a behavior + privacy regression), and adding one of veyyon's OWN providers here (native,
 * builtin, veyyon-plugins) would wrongly gate first-party config off. The assertion pins the whole set
 * rather than a sample so any drift in either direction fails.
 */
describe("foreign provider gate", () => {
	const EXPECTED = [
		"agents",
		"agents-md",
		"claude",
		"claude-plugins",
		"cline",
		"codex",
		"cursor",
		"gemini",
		"github",
		"opencode",
		"vscode",
		"windsurf",
	];

	it("gates exactly the known foreign-tool providers and no first-party ones", () => {
		expect([...getForeignProviderIds()].sort()).toEqual([...EXPECTED].sort());
	});

	it("never gates veyyon's own first-party providers", () => {
		for (const own of ["native", "builtin", "veyyon-plugins", "ssh", "mcp"]) {
			expect(FOREIGN_PROVIDER_IDS.has(own)).toBe(false);
		}
	});

	it("treats a representative foreign tool (claude) as gated", () => {
		expect(FOREIGN_PROVIDER_IDS.has("claude")).toBe(true);
		expect(getForeignProviderIds()).toContain("claude");
	});

	it("returns a defensive copy so callers cannot mutate the registry's gate set", () => {
		const ids = getForeignProviderIds();
		ids.push("injected-provider");
		expect(getForeignProviderIds()).not.toContain("injected-provider");
	});
});
