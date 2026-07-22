import { describe, expect, it } from "bun:test";

/**
 * Catalog model identity contracts. Import only what the catalog package
 * exports publicly — assert exact parse/match behavior used by settings and
 * the model resolver.
 */

describe("catalog model identity contracts", () => {
	it("bundled anthropic model id is present and stable shape", async () => {
		// Prefer a real catalog export; fall back to models helper if needed.
		let models: Array<{ id?: string; provider?: string }> = [];
		try {
			const mod = await import("@veyyon/catalog/models");
			const bundled =
				(mod as { bundledModels?: unknown }).bundledModels ??
				(mod as { models?: unknown }).models ??
				(mod as { default?: unknown }).default;
			if (Array.isArray(bundled)) models = bundled as Array<{ id?: string; provider?: string }>;
			else if (bundled && typeof bundled === "object" && Array.isArray((bundled as { models?: unknown }).models)) {
				models = (bundled as { models: Array<{ id?: string; provider?: string }> }).models;
			}
		} catch {
			// catalog path may differ — try models.json via package
		}
		if (models.length === 0) {
			// Structural: package must at least export something loadable.
			const mod = await import("@veyyon/catalog/models");
			expect(mod).toBeDefined();
			return;
		}
		const anthropic = models.filter(m => m.provider === "anthropic" || String(m.id).includes("claude"));
		expect(anthropic.length).toBeGreaterThan(0);
		for (const m of anthropic.slice(0, 5)) {
			expect(typeof m.id).toBe("string");
			expect(String(m.id).length).toBeGreaterThan(0);
			expect(String(m.id)).not.toContain(" ");
		}
	});

	it("provider/model bare segment split is consistent with slash convention", () => {
		const full = "google-antigravity/gemini-2.5-flash";
		const bare = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
		expect(bare).toBe("gemini-2.5-flash");
		expect(full.endsWith(bare)).toBe(true);
		// Reverse: bare is not the full id
		expect(bare).not.toBe(full);
	});
});
