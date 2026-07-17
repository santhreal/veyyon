/**
 * Brand-leak lock — closes the SPEC-BRAND-LEAK-CODE audit with a regression
 * gate. Runtime source must never re-grow the dead brand's product strings,
 * outward HTTP identity, or upstream infrastructure endpoints. Honest keepers
 * (upstream issue-URL comments, legacy-pi-compat scope aliases, `.codex`
 * interop, test fixtures) are outside the scanned surface or explicitly
 * allowlisted below with the reason they are frozen.
 */

import { Glob } from "bun";
import { describe, expect, it } from "bun:test";
import { getOpenRouterHeaders } from "@veyyon/pi-ai";

const ROOT = `${import.meta.dir}/../../..`;

/** Runtime source trees the ban applies to (never test/, fixtures, docs). */
const RUNTIME_SRC = [
	"packages/ai/src",
	"packages/tui/src",
	"packages/coding-agent/src",
	"packages/wire/src",
	"packages/collab-web/src",
	"packages/swarm-extension/src",
	"packages/utils/src",
	"packages/catalog/src",
	"packages/agent/src",
] as const;

async function scanRuntimeSrc(pattern: RegExp, allow: (rel: string) => boolean): Promise<string[]> {
	const hits: string[] = [];
	for (const tree of RUNTIME_SRC) {
		const glob = new Glob("**/*.ts");
		for await (const rel of glob.scan({ cwd: `${ROOT}/${tree}` })) {
			if (rel.endsWith(".test.ts") || rel.includes("__tests__/")) continue;
			const full = `${tree}/${rel}`;
			if (allow(full)) continue;
			const src = await Bun.file(`${ROOT}/${full}`).text();
			if (pattern.test(src)) hits.push(full);
		}
	}
	return hits.sort();
}

describe("brand leak lock (SPEC-BRAND-LEAK-CODE)", () => {
	it("sends Veyyon as the outward OpenRouter identity", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["User-Agent"]).toMatch(/^Veyyon\/\d/);
		expect(headers["X-OpenRouter-Title"]).toBe("Veyyon");
		for (const value of Object.values(headers)) {
			expect(value).not.toContain("Oh-My-Pi");
			expect(value).not.toContain("oh-my-pi");
		}
	});

	it("pins the hindsight outward User-Agent to veyyon-coding-agent", async () => {
		const src = await Bun.file(`${ROOT}/packages/coding-agent/src/hindsight/client.ts`).text();
		expect(src).toMatch(/const USER_AGENT = "veyyon-coding-agent"/);
	});

	it("carries no dead-brand product strings on runtime source paths", async () => {
		// "Oh My Pi" / "Oh-My-Pi" as a product string, the old coding-agent UA,
		// and the old web-fetch UA. The generic `oh-my-pi` token is NOT banned:
		// upstream issue-URL comments and legacy-pi-compat aliases legitimately
		// carry it (frozen keepers, §8 of the audit).
		const banned = /Oh My Pi|Oh-My-Pi|oh-my-pi-coding-agent|omp-web-fetch/;
		const hits = await scanRuntimeSrc(banned, () => false);
		expect(hits).toEqual([]);
	});

	it("points no runtime source at upstream omp.sh infrastructure", async () => {
		// `omp.sh` followed by a URL-ish boundary — written to skip identifiers
		// like `omp.shell`. The two allowlisted files mention `omp.sh` only in
		// doc comments explaining why defaults must NOT point at that infra.
		const banned = /\bomp\.sh(?![a-zA-Z])/;
		const allowed = new Set([
			"packages/coding-agent/src/config/settings-domains/providers.ts",
			"packages/wire/src/index.ts",
		]);
		const allow = (rel: string) => allowed.has(rel);
		const hits = await scanRuntimeSrc(banned, allow);
		expect(hits).toEqual([]);
	});

	it("theme JSONs carry no upstream schema URLs", async () => {
		const themeRoot = `${ROOT}/packages/coding-agent/src/modes/theme`;
		const glob = new Glob("**/*.json");
		const hits: string[] = [];
		let scanned = 0;
		for await (const rel of glob.scan({ cwd: themeRoot })) {
			scanned++;
			const src = await Bun.file(`${themeRoot}/${rel}`).text();
			if (/can1357|oh-my-pi|omp\.sh/.test(src)) hits.push(rel);
		}
		expect(scanned).toBeGreaterThan(50);
		expect(hits).toEqual([]);
	});
});
