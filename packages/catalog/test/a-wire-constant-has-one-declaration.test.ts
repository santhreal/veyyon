/**
 * A value that goes on a provider's wire is declared once, in the catalog.
 *
 * WHY THIS SUITE EXISTS. `@veyyon/catalog` is the declared owner of what veyyon puts
 * on a provider's wire: hosts, paths, header values, client identity. Three of those
 * had a SECOND declaration in a package that consumes the catalog, under the same
 * name and with the same value, so the owner was being bypassed rather than read.
 * Same-name-same-value is the quiet half of duplication: it costs nothing until the
 * day someone edits one copy.
 *
 * What each drift would have done, and why none of them would have looked like a bug:
 *
 *   DEVIN_IDE_VERSION / DEVIN_EXTENSION_VERSION. Sent as request metadata by model
 *   discovery in the catalog AND by the chat provider in `@veyyon/ai`, which held its
 *   own pair. Bumping one leaves the two halves of a single session identifying
 *   themselves to Devin as different clients, which the server is entitled to act on.
 *
 *   FETCH_AVAILABLE_MODELS_PATH. Appended to an Antigravity endpoint by the catalog's
 *   discovery and by `@veyyon/ai`'s usage reader. If the path moved, the copy that was
 *   not updated would 404, and a usage reader that cannot reach its endpoint reports
 *   "no quota information" rather than a wrong URL.
 *
 *   CODEX_BASE_URL. Six modules already import it from `wire/codex`; the web-search
 *   provider in `@veyyon/coding-agent` spelled the literal itself. A host change would
 *   have moved every caller except web search, which would have kept posting to the
 *   old endpoint under the user's real credentials.
 *
 * The assertions are cross-PACKAGE on purpose. A per-package lock is exactly what
 * these three slipped through: each copy was the only declaration in its own package.
 */
import { describe, expect, it } from "bun:test";
// `readdir` is overloaded on its options, and `ReturnType<typeof readdir>` picks the LAST overload,
// which reads names as buffers. Naming `Dirent` gives the walk below the string-named entries the
// `withFileTypes` call actually returns, instead of a `Buffer` that has no `endsWith`.
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { FETCH_AVAILABLE_MODELS_PATH } from "../src/discovery/antigravity";
import { DEVIN_EXTENSION_VERSION, DEVIN_IDE_VERSION } from "../src/discovery/devin";
import { CODEX_BASE_URL } from "../src/wire/codex";

/** The workspace's `packages/` directory, from this file rather than from the cwd. */
const PACKAGES = path.join(import.meta.dir, "..", "..");

/** Every `.ts` source file under every package's `src`, excluding generated output. */
async function workspaceSources(): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			// A package without a `src` is not a finding; every other read error is
			// re-raised by the loop below when it tries to read a file it listed.
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full);
		}
	};
	for (const entry of await readdir(PACKAGES, { withFileTypes: true })) {
		if (entry.isDirectory()) await walk(path.join(PACKAGES, entry.name, "src"));
	}
	return found;
}

const SOURCES = await workspaceSources();

/**
 * Files declaring `const <name> = ...`, relative to `packages/`.
 *
 * DECLARATIONS, not mentions. A re-export (`export { X } from "..."`) and an import
 * both keep one owner and must not count; a second `const X =` is the finding.
 */
async function declarersOf(name: string): Promise<string[]> {
	const declaration = new RegExp(`^\\s*(?:export )?const ${name}\\s*=`, "m");
	const out: string[] = [];
	for (const file of SOURCES) {
		if (declaration.test(await readFile(file, "utf8"))) out.push(path.relative(PACKAGES, file));
	}
	return out.sort();
}

describe("the guard on this guard", () => {
	/**
	 * A scan that found no files would pass every assertion below while proving
	 * nothing, which is the failure mode of every structural lock.
	 */
	it("scanned the workspace's sources", () => {
		expect(SOURCES.length).toBeGreaterThan(500);
	});
});

describe("Devin's client identity", () => {
	/** The real values. They are sent verbatim, so the strings are the contract. */
	it("names the IDE and extension versions the requests claim", () => {
		expect(DEVIN_IDE_VERSION).toBe("3.2.23");
		expect(DEVIN_EXTENSION_VERSION).toBe("1.48.2");
	});

	/** THE regression: `@veyyon/ai`'s provider had its own pair of these. */
	it("is declared once for each, in the catalog", async () => {
		expect(await declarersOf("DEVIN_IDE_VERSION")).toEqual(["catalog/src/discovery/devin.ts"]);
		expect(await declarersOf("DEVIN_EXTENSION_VERSION")).toEqual(["catalog/src/discovery/devin.ts"]);
	});

	/**
	 * And the provider reads THIS module, proven by identity rather than by equality:
	 * a re-declared copy with the same value would satisfy `toBe` on the string.
	 */
	it("is the same value the ai provider sends", async () => {
		const provider = await readFile(path.join(PACKAGES, "ai", "src", "providers", "devin.ts"), "utf8");

		expect(provider).toContain("DEVIN_IDE_VERSION,");
		expect(provider).toContain('from "@veyyon/catalog/discovery/devin"');
	});
});

describe("Antigravity's fetchAvailableModels path", () => {
	/** The real value, which is appended to whichever endpoint is in play. */
	it("is the path both discovery and the usage reader append", () => {
		expect(FETCH_AVAILABLE_MODELS_PATH).toBe("/v1internal:fetchAvailableModels");
	});

	/** One declaration, in the catalog that owns the wire. */
	it("is declared once, in the catalog", async () => {
		expect(await declarersOf("FETCH_AVAILABLE_MODELS_PATH")).toEqual(["catalog/src/discovery/antigravity.ts"]);
	});

	/** The usage reader imports it rather than restating it. */
	it("is imported by the ai usage reader", async () => {
		const usage = await readFile(path.join(PACKAGES, "ai", "src", "usage", "google-antigravity.ts"), "utf8");

		expect(usage).toContain('import { FETCH_AVAILABLE_MODELS_PATH } from "@veyyon/catalog/discovery/antigravity"');
	});
});

describe("the Codex base URL", () => {
	/** The real host every Codex request is built on. */
	it("is the backend the requests are built on", () => {
		expect(CODEX_BASE_URL).toBe("https://chatgpt.com/backend-api");
	});

	/**
	 * One declaration. Six modules already imported it and one respelled the literal,
	 * which is the shape that makes a host change look complete when it is not.
	 */
	it("is declared once, in the catalog's codex wire module", async () => {
		expect(await declarersOf("CODEX_BASE_URL")).toEqual(["catalog/src/wire/codex.ts"]);
	});

	/** Including the web-search provider that used to hold the second copy. */
	it("is imported by the web-search provider", async () => {
		const provider = await readFile(
			path.join(PACKAGES, "coding-agent", "src", "web", "search", "providers", "codex.ts"),
			"utf8",
		);

		expect(provider).toContain("CODEX_BASE_URL,");
		expect(provider).toContain('from "@veyyon/catalog/wire/codex"');
	});

	/**
	 * NOBODY spells the host as a literal outside its owner. The name-based lock above
	 * misses the other half of the disease: a caller writing the URL inline needs no
	 * constant at all, and that is how `provider-endpoints.ts` came to exist.
	 */
	it("is not written as a literal anywhere else", async () => {
		const offenders: string[] = [];
		for (const file of SOURCES) {
			const relative = path.relative(PACKAGES, file);
			if (relative === "catalog/src/wire/codex.ts") continue;
			if ((await readFile(file, "utf8")).includes('"https://chatgpt.com/backend-api"')) offenders.push(relative);
		}

		expect(offenders).toEqual([]);
	});
});
