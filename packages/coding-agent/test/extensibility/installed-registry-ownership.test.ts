import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addInstalledPlugin,
	collectReferencedPaths,
	getInstalledPlugin,
	getInstalledPluginsRegistryPath,
	getPluginsCacheDir,
	type InstalledPluginEntry,
	readInstalledPluginsRegistry,
	removeInstalledPlugin,
	writeInstalledPluginsRegistry,
} from "@veyyon/coding-agent/extensibility/plugins/installed-registry";
// The marketplace registry barrel re-exports the installed-plugins surface from
// the owner. Importing through it proves the re-export stays wired for the many
// marketplace consumers that import from `./registry`.
import * as marketplaceRegistry from "@veyyon/coding-agent/extensibility/plugins/marketplace/registry";

/**
 * `installed-registry.ts` is the single owner of the installed-plugins registry:
 * the `InstalledPluginsRegistry`/`InstalledPluginEntry` types, the on-disk path
 * helpers, read/write, the pure CRUD transforms, and `collectReferencedPaths`.
 * `marketplace/registry.ts` and `marketplace/types.ts` used to carry byte-
 * identical private copies of all of these — a latent divergence bug where a
 * plugin could read/validate differently depending on which registry module a
 * caller reached for. These tests lock that the owner exports the full surface
 * and that the marketplace layer re-exports the SAME references, not a fork.
 */

describe("installed-registry owner surface", () => {
	it("exports the full installed-plugins registry API from the owner path", () => {
		expect(typeof getInstalledPluginsRegistryPath).toBe("function");
		expect(typeof getPluginsCacheDir).toBe("function");
		expect(typeof readInstalledPluginsRegistry).toBe("function");
		expect(typeof writeInstalledPluginsRegistry).toBe("function");
		expect(typeof addInstalledPlugin).toBe("function");
		expect(typeof removeInstalledPlugin).toBe("function");
		expect(typeof getInstalledPlugin).toBe("function");
		expect(typeof collectReferencedPaths).toBe("function");
	});

	it("computes the installed_plugins.json path under the plugins cache dir", () => {
		const regPath = getInstalledPluginsRegistryPath();
		expect(regPath.endsWith("installed_plugins.json")).toBe(true);
		expect(getPluginsCacheDir().endsWith(join("cache", "plugins"))).toBe(true);
	});

	it("collectReferencedPaths dedups installPaths across multiple registries", () => {
		const entry = (installPath: string): InstalledPluginEntry => ({
			scope: "user",
			installPath,
			version: "1.0.0",
			installedAt: "2026-01-01T00:00:00Z",
			lastUpdated: "2026-01-01T00:00:00Z",
		});
		let userReg = addInstalledPlugin({ version: 2, plugins: {} }, "a@m", entry("/cache/shared"));
		const projReg = addInstalledPlugin({ version: 2, plugins: {} }, "a@m", entry("/cache/shared"));
		userReg = addInstalledPlugin(userReg, "b@m", entry("/cache/only-user"));

		const referenced = collectReferencedPaths(userReg, projReg);
		expect(referenced).toEqual(new Set(["/cache/shared", "/cache/only-user"]));
	});
});

describe("marketplace registry re-export identity", () => {
	it("re-exports the exact same installed-registry function references as the owner", () => {
		expect(marketplaceRegistry.getInstalledPluginsRegistryPath).toBe(getInstalledPluginsRegistryPath);
		expect(marketplaceRegistry.getPluginsCacheDir).toBe(getPluginsCacheDir);
		expect(marketplaceRegistry.readInstalledPluginsRegistry).toBe(readInstalledPluginsRegistry);
		expect(marketplaceRegistry.writeInstalledPluginsRegistry).toBe(writeInstalledPluginsRegistry);
		expect(marketplaceRegistry.addInstalledPlugin).toBe(addInstalledPlugin);
		expect(marketplaceRegistry.removeInstalledPlugin).toBe(removeInstalledPlugin);
		expect(marketplaceRegistry.getInstalledPlugin).toBe(getInstalledPlugin);
		expect(marketplaceRegistry.collectReferencedPaths).toBe(collectReferencedPaths);
	});
});

describe("installed-registry single-owner lock", () => {
	it("no sibling plugins module redefines the registry type, reader, or path collector", () => {
		const dir = join(import.meta.dir, "..", "..", "src", "extensibility", "plugins");
		const offenders: string[] = [];
		const scan = (base: string, prefix: string) => {
			for (const ent of readdirSync(base, { withFileTypes: true })) {
				if (ent.name === "installed-registry.ts") continue;
				const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
				if (ent.isDirectory()) {
					scan(join(base, ent.name), rel);
					continue;
				}
				if (!ent.name.endsWith(".ts")) continue;
				const src = readFileSync(join(base, ent.name), "utf8");
				// A reintroduced private copy would re-declare the interface or the
				// read/collect functions rather than importing them from the owner.
				if (/interface InstalledPluginsRegistry\b/.test(src)) {
					offenders.push(`${rel}: redefines InstalledPluginsRegistry`);
				}
				if (/function readInstalledPluginsRegistry\b/.test(src)) {
					offenders.push(`${rel}: redefines readInstalledPluginsRegistry`);
				}
				if (/function collectReferencedPaths\b/.test(src)) {
					offenders.push(`${rel}: redefines collectReferencedPaths`);
				}
			}
		};
		scan(dir, "");
		expect(offenders).toEqual([]);
	});
});
