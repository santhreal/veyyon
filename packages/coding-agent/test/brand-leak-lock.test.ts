/**
 * Brand-leak lock — closes the SPEC-BRAND-LEAK-CODE audit with a regression
 * gate. Runtime source must never re-grow the dead brand's product strings,
 * outward HTTP identity, or upstream infrastructure endpoints. Honest keepers
 * (upstream issue-URL comments, legacy-pi-compat scope aliases, `.codex`
 * interop, test fixtures) are outside the scanned surface or explicitly
 * allowlisted below with the reason they are frozen.
 */

import { describe, expect, it } from "bun:test";
import { getOpenRouterHeaders } from "@veyyon/ai";
import { Glob } from "bun";

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

/**
 * Hand-authored native loader shims. These are committed `.js` (not `src/*.ts`),
 * so the RUNTIME_SRC `.ts` scan never saw them — which is exactly how a
 * `can1357/oh-my-pi/releases/latest/download` URL shipped in the natives loader,
 * telling users to fetch veyyon's OWN `.node` assets from a fork's repo. Scanned
 * for upstream release/download infra below so that leak class can't come back.
 */
const NATIVE_LOADER_SRC = ["packages/natives/native"] as const;

async function scanTrees(
	trees: readonly string[],
	globPattern: string,
	pattern: RegExp,
	allow: (rel: string) => boolean,
): Promise<string[]> {
	const hits: string[] = [];
	for (const tree of trees) {
		const glob = new Glob(globPattern);
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

async function scanRuntimeSrc(pattern: RegExp, allow: (rel: string) => boolean): Promise<string[]> {
	return scanTrees(RUNTIME_SRC, "**/*.ts", pattern, allow);
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

	it("no runtime source names the upstream author or points at upstream release infra", async () => {
		// The upstream author's username (`can1357`) has no legitimate use in
		// runtime source: every occurrence was an inherited breadcrumb — a bare
		// upstream issue-tracker link in a comment, or (worse) inside a user-facing
		// error hint string. `oh-my-pi/releases` is the release/download infra that
		// shipped in the natives loader telling users to fetch veyyon's OWN `.node`
		// assets from a fork's repo. Both are banned across runtime `.ts` AND the
		// hand-authored native `.js` loaders (previously unscanned — that gap is
		// exactly how the download URL leaked). The `oh-my-pi` token alone stays
		// allowed for the legacy-pi-compat scope aliases (frozen keepers, §8).
		const banned = /can1357|oh-my-pi\/releases/;
		const hits = [
			...(await scanTrees(RUNTIME_SRC, "**/*.ts", banned, () => false)),
			...(await scanTrees(NATIVE_LOADER_SRC, "**/*.{js,ts}", banned, () => false)),
		].sort();
		expect(hits).toEqual([]);
	});

	it("the natives loader points its download help at santhreal/veyyon, not a fork", async () => {
		// Locks the actual fix: the loader's release-download base is derived from
		// the package's own repository.url (santhreal/veyyon), so a stale upstream
		// URL can never re-appear in the "download manually" help a user sees when
		// the native addon fails to load.
		const src = await Bun.file(`${ROOT}/packages/natives/native/loader-state.js`).text();
		expect(src).toContain("releasesDownloadBase");
		expect(src).toContain('"santhreal/veyyon"');
		expect(src).not.toMatch(/can1357|oh-my-pi\/releases/);
	});

	it("every @veyyon/* package manifest is authored by santhreal, never an upstream/placeholder name", async () => {
		// The published author identity of veyyon's OWN packages is `santhreal`
		// (the user's explicit decision). Two foreign names had leaked in: the
		// upstream fork author `Can Boluk` across most manifests, and a
		// zero-footprint placeholder `Derek Rynd` on @veyyon/swarm-extension. This
		// scans every workspace package manifest so neither — nor any other
		// non-santhreal author — can reappear when a package is added or bumped.
		const glob = new Glob("packages/*/package.json");
		const offenders: Array<{ pkg: string; author: unknown }> = [];
		let scanned = 0;
		for await (const rel of glob.scan({ cwd: ROOT })) {
			const manifest = (await Bun.file(`${ROOT}/${rel}`).json()) as { name?: string; author?: unknown };
			if (typeof manifest.name !== "string" || !manifest.name.startsWith("@veyyon/")) continue;
			scanned++;
			if (manifest.author !== "santhreal") offenders.push({ pkg: manifest.name, author: manifest.author });
		}
		expect(scanned).toBeGreaterThan(10);
		expect(offenders).toEqual([]);
	});

	it("the workspace Cargo.toml is authored by santhreal", async () => {
		const cargo = await Bun.file(`${ROOT}/Cargo.toml`).text();
		// The [workspace.package] authors array must be exactly santhreal — no
		// leftover upstream `Can Boluk`.
		expect(cargo).toMatch(/authors\s*=\s*\[\s*"santhreal"\s*\]/);
		expect(cargo).not.toContain("Can Boluk");
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
