import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePluginSource } from "@veyyon/coding-agent/extensibility/plugins/marketplace/source-resolver";
import type {
	MarketplaceCatalogMetadata,
	MarketplacePluginEntry,
	PluginSource,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace/types";

/**
 * resolvePluginSource turns a marketplace plugin entry's `source` into a verified
 * absolute directory. The relative-string branch ("./plugins/foo" within the
 * marketplace clone) is the pure, fs-testable one, and its containment guard is
 * safety-critical: a "./.." escape must be rejected, and a `pluginRoot` prepend must
 * be normalized before the containment check. It had no test. These pin the happy
 * path, the pluginRoot prepend, the containment-escape rejection, and the exact
 * error text for every early-throw branch (non-"./", missing clone path, missing
 * dir, file-not-dir, npm-unsupported, unknown source type) so a silent regression in
 * marketplace plugin resolution cannot slip through.
 */

let clone: string;
let tmpDir: string;

function entry(source: PluginSource): MarketplacePluginEntry {
	return { name: "p", source } as MarketplacePluginEntry;
}

function ctx(over: { marketplaceClonePath?: string; catalogMetadata?: MarketplaceCatalogMetadata } = {}) {
	return {
		marketplaceClonePath: over.marketplaceClonePath,
		catalogMetadata: over.catalogMetadata,
		tmpDir,
	};
}

beforeAll(async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-src-resolver-"));
	clone = path.join(root, "clone");
	tmpDir = path.join(root, "tmp");
	await fs.mkdir(path.join(clone, "plugins", "foo"), { recursive: true });
	await fs.mkdir(path.join(clone, "root", "plugins", "bar"), { recursive: true });
	await fs.writeFile(path.join(clone, "plugins", "afile"), "x");
	await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
	await fs.rm(path.dirname(clone), { recursive: true, force: true });
});

describe("resolvePluginSource — relative source", () => {
	it("resolves a './' path to its absolute directory inside the clone", async () => {
		const result = await resolvePluginSource(entry("./plugins/foo"), ctx({ marketplaceClonePath: clone }));
		expect(result).toEqual({ dir: path.join(clone, "plugins", "foo") });
	});

	it("prepends catalog pluginRoot before resolving", async () => {
		const result = await resolvePluginSource(
			entry("./plugins/bar"),
			ctx({ marketplaceClonePath: clone, catalogMetadata: { pluginRoot: "root" } }),
		);
		expect(result).toEqual({ dir: path.join(clone, "root", "plugins", "bar") });
	});
});

describe("resolvePluginSource — relative source rejections", () => {
	it("rejects a path that does not start with './'", async () => {
		await expect(resolvePluginSource(entry("plugins/foo"), ctx({ marketplaceClonePath: clone }))).rejects.toThrow(
			/must start with "\.\/"/,
		);
	});

	it("rejects a relative source when marketplaceClonePath is absent", async () => {
		await expect(resolvePluginSource(entry("./plugins/foo"), ctx())).rejects.toThrow(
			/marketplaceClonePath is required/,
		);
	});

	it("rejects a './..' path that escapes the marketplace root", async () => {
		await expect(resolvePluginSource(entry("./../../etc"), ctx({ marketplaceClonePath: clone }))).rejects.toThrow(
			/resolves outside marketplace root/,
		);
	});

	it("rejects a resolved path that does not exist on disk", async () => {
		await expect(
			resolvePluginSource(entry("./plugins/missing"), ctx({ marketplaceClonePath: clone })),
		).rejects.toThrow(/does not exist/);
	});

	it("rejects a resolved path that is a file, not a directory", async () => {
		await expect(resolvePluginSource(entry("./plugins/afile"), ctx({ marketplaceClonePath: clone }))).rejects.toThrow(
			/does not exist/,
		);
	});
});

describe("resolvePluginSource — object source rejections", () => {
	it("rejects an npm source as not yet supported", async () => {
		await expect(resolvePluginSource(entry({ source: "npm" } as unknown as PluginSource), ctx())).rejects.toThrow(
			/npm plugin sources are not yet supported/,
		);
	});

	it("rejects an unknown source type", async () => {
		await expect(resolvePluginSource(entry({ source: "bogus" } as unknown as PluginSource), ctx())).rejects.toThrow(
			/Unknown plugin source type: "bogus"/,
		);
	});
});
