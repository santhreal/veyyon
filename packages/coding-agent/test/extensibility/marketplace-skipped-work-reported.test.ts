/**
 * Locks out two bare `catch {}` bodies in the marketplace manager.
 *
 * Both sat on sweeps that iterate and continue, which is right: one bad
 * marketplace must not stop the refresh, and one bad plugin must not stop the
 * upgrade. What was wrong is that the skip left no trace anywhere.
 *
 * - `refreshStaleMarketplaces`: a catalog that has failed to refresh for weeks
 *   is indistinguishable from one that is current, and every plugin it serves
 *   silently stops receiving updates.
 * - `upgradeAllPlugins`: the return value only names what succeeded, so "upgrade
 *   everything" reports partial success as success and the plugin that never
 *   moves is invisible.
 *
 * If this regresses, both failures go back to being unobservable and the only
 * symptom is software that quietly stays at an old version.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MarketplaceManager } from "@veyyon/coding-agent/extensibility/plugins/marketplace";
import { logger, removeWithRetries } from "@veyyon/utils";

let tempDir = "";
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

function makeManager(): MarketplaceManager {
	return new MarketplaceManager({
		marketplacesRegistryPath: path.join(tempDir, "marketplaces.json"),
		installedRegistryPath: path.join(tempDir, "installed_plugins.json"),
		marketplacesCacheDir: path.join(tempDir, "cache", "marketplaces"),
		pluginsCacheDir: path.join(tempDir, "cache", "plugins"),
		clearPluginRootsCache: () => {},
	});
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "marketplace-skip-loud-"));
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

describe("A marketplace catalog that cannot be refreshed is reported", () => {
	/** One stale entry, old enough that the 24 h staleness check fires. */
	async function writeStaleRegistry(): Promise<void> {
		await fs.writeFile(
			path.join(tempDir, "marketplaces.json"),
			JSON.stringify({
				version: 1,
				marketplaces: [
					{
						name: "acme",
						source: { source: "git", url: "https://example.invalid/acme.git" },
						updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
					},
				],
			}),
		);
	}

	test("warns with the marketplace name and says the catalog stays stale", async () => {
		await writeStaleRegistry();
		const manager = makeManager();
		vi.spyOn(manager, "updateMarketplace").mockRejectedValue(new Error("network is unreachable"));

		await manager.refreshStaleMarketplaces();

		const reported = warnings.filter(w => w.message.includes("Marketplace catalog refresh failed"));
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("stays stale");
		expect(reported[0]?.fields.marketplace).toBe("acme");
		expect(String(reported[0]?.fields.error)).toContain("network is unreachable");
	});

	/** The sweep must still be best-effort: a failure is reported, not thrown. */
	test("does not throw out of the sweep", async () => {
		await writeStaleRegistry();
		const manager = makeManager();
		vi.spyOn(manager, "updateMarketplace").mockRejectedValue(new Error("network is unreachable"));

		await expect(manager.refreshStaleMarketplaces()).resolves.toBeUndefined();
	});

	test("says nothing when the refresh succeeds", async () => {
		await writeStaleRegistry();
		const manager = makeManager();
		vi.spyOn(manager, "updateMarketplace").mockResolvedValue({
			name: "acme",
			source: { source: "git", url: "https://example.invalid/acme.git" },
			updatedAt: new Date().toISOString(),
		} as never);

		await manager.refreshStaleMarketplaces();

		expect(warnings.filter(w => w.message.includes("Marketplace catalog refresh failed"))).toEqual([]);
	});
});

describe("A plugin that could not be upgraded is reported", () => {
	const outdated = [
		{ pluginId: "acme/broken", scope: "user" as const, from: "1.0.0", to: "2.0.0" },
		{ pluginId: "acme/fine", scope: "user" as const, from: "1.0.0", to: "1.1.0" },
	];

	test("warns with the plugin id and says the installed version is unchanged", async () => {
		const manager = makeManager();
		vi.spyOn(manager, "checkForUpdates").mockResolvedValue(outdated);
		vi.spyOn(manager, "upgradePlugin").mockImplementation(async (pluginId: string) => {
			if (pluginId === "acme/broken") throw new Error("checksum mismatch");
			return { version: "1.1.0" } as never;
		});

		const results = await manager.upgradeAllPlugins();

		const reported = warnings.filter(w => w.message.includes("Plugin upgrade failed"));
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("installed version is unchanged");
		expect(reported[0]?.fields.pluginId).toBe("acme/broken");
		expect(reported[0]?.fields.scope).toBe("user");
		expect(String(reported[0]?.fields.error)).toContain("checksum mismatch");
		// Partial success is still returned, which is the behavior being preserved.
		expect(results.map(r => r.pluginId)).toEqual(["acme/fine"]);
	});

	test("says nothing when every upgrade succeeds", async () => {
		const manager = makeManager();
		vi.spyOn(manager, "checkForUpdates").mockResolvedValue(outdated);
		vi.spyOn(manager, "upgradePlugin").mockResolvedValue({ version: "9.9.9" } as never);

		const results = await manager.upgradeAllPlugins();

		expect(warnings.filter(w => w.message.includes("Plugin upgrade failed"))).toEqual([]);
		expect(results).toHaveLength(2);
	});
});
