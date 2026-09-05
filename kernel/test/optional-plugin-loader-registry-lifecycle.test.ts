/**
 * WHY THIS SUITE EXISTS:
 *
 * The kernel (@veyyon/kernel) owns the plugin loader, contribution registry, and session spine
 * while naming no tool and no host. Plugins and their contributions (tools, hooks, extensions,
 * commands, message kinds, settings) are strictly optional:
 *   1. Plugin absence or disablement must never initialize or corrupt unrelated contributions.
 *   2. Registration, unregistration, load failures, and duplicate collisions must preserve a
 *      coherent lifecycle state without partial corruption.
 *   3. Unloading a plugin or contribution domain must release only its registered contributions
 *      without losing or damaging others.
 *   4. Manifest parsing, spec parsing, ID validation, git URL handling, and diagnostic reporting
 *      must uphold contract invariants across the workspace.
 *
 * WHAT IT DOES NOT CATCH:
 * Runtime execution of specific external CLI binaries or network cloning.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginManifest } from "@veyyon/plugin";
import type { AgentMessage } from "@veyyon/session";
import { TempDir } from "@veyyon/utils";
import { StringEnum } from "../src/loader/legacy-pi-ai-shim";
import {
	type ExtensibilityArtifact,
	factoryExportMissingMessage,
	invalidArtifactFieldMessage,
	moduleImportFailedMessage,
	nameConflictMessage,
} from "../src/loader/load-failure";
import { MANIFEST_KEYS, type ManifestHolder, manifestFromPackageJson } from "../src/loader/manifest-key";
import { isGitSpec, parseGitUrl, SHORTHAND_PREFIXES } from "../src/loader/plugins/git-url";
import {
	addInstalledPlugin,
	collectReferencedPaths,
	getInstalledPlugin,
	type InstalledPluginEntry,
	type InstalledPluginsRegistry,
	readInstalledPluginsRegistry,
	removeInstalledPlugin,
	writeInstalledPluginsRegistry,
} from "../src/loader/plugins/installed-registry";
import {
	cachePlugin,
	cleanOrphanedCache,
	getCachedPluginPath,
	isCached,
	isValidVersionForCache,
	removeCachedPlugin,
} from "../src/loader/plugins/marketplace/cache";
import {
	addMarketplaceEntry,
	getMarketplaceEntry,
	readMarketplacesRegistry,
	removeMarketplaceEntry,
	writeMarketplacesRegistry,
} from "../src/loader/plugins/marketplace/registry";
import type { MarketplaceRegistryEntry, MarketplacesRegistry } from "../src/loader/plugins/marketplace/types";
import {
	extractPackageName,
	formatPluginSpec,
	type ParsedPluginSpec,
	parsePluginSpec,
} from "../src/loader/plugins/parser";
import { buildPluginId, isValidNameSegment, parsePluginId } from "../src/loader/plugins/plugin-id";
import { normalizePluginRuntimeConfig } from "../src/loader/plugins/runtime-config";
import type { PluginRuntimeConfig } from "../src/loader/plugins/types";
import { LEGACY_TOOL_DEFINITION_MARKER } from "../src/registry/legacy-tool-marker";
import { applyToolProxy } from "../src/registry/tool-proxy";
import { Type } from "../src/registry/typebox";
import { agentMessageKind } from "../src/session/message-kinds";

describe("Optional Plugin Manifest & Loader Invariants", () => {
	describe("1. Workspace Plugin Manifest Discovery & Invariants", () => {
		const repoRoot = path.resolve(import.meta.dir, "..", "..");
		const pluginsDir = path.join(repoRoot, "plugins");

		it("enumerates all workspace plugins and verifies explicit manifest declarations and library opt-outs", () => {
			const pluginDirs = fs
				.readdirSync(pluginsDir, { withFileTypes: true })
				.filter(d => d.isDirectory())
				.map(d => d.name)
				.sort();

			// Exact 5 workspace plugin packages
			expect(pluginDirs).toEqual(["argot", "hashline", "mnemopi", "mode-swarm", "web"]);

			const optOuts: Record<string, string> = {
				web: "Standalone scraper library exported for direct import, opts out of plugin manifest",
				mnemopi: "Local SQLite memory engine, CLI, and MCP server, opts out of plugin manifest",
				hashline: "Standalone pluggable line-anchored patch engine, opts out of plugin manifest",
				argot: "Standalone per-project shorthand vocabulary codec, opts out of plugin manifest",
			};

			for (const dirName of pluginDirs) {
				const pkgJsonPath = path.join(pluginsDir, dirName, "package.json");
				expect(fs.existsSync(pkgJsonPath)).toBe(true);
				const raw = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
				const manifest = manifestFromPackageJson<PluginManifest>(raw);

				if (dirName === "mode-swarm") {
					expect(raw.name).toBe("@veyyon/swarm-extension");
					expect(manifest).toBeDefined();
					expect(manifest?.extensions).toEqual(["./src/extension.ts"]);
				} else {
					expect(manifest).toBeUndefined();
					expect(optOuts[dirName]).toBeDefined();
				}
			}
		});

		it("respects manifest key precedence: veyyon > omp > pi", () => {
			expect(MANIFEST_KEYS).toEqual(["veyyon", "omp", "pi"]);

			const veyyonPkg = {
				veyyon: { version: "1.0.0", name: "v" },
				omp: { version: "2.0.0" },
				pi: { version: "3.0.0" },
			};
			expect(manifestFromPackageJson<{ version: string; name?: string }>(veyyonPkg)).toEqual({
				version: "1.0.0",
				name: "v",
			});

			const ompPkg = { omp: { version: "2.0.0", name: "o" }, pi: { version: "3.0.0" } };
			expect(manifestFromPackageJson<{ version: string; name?: string }>(ompPkg)).toEqual({
				version: "2.0.0",
				name: "o",
			});

			const piPkg = { pi: { version: "3.0.0", name: "p" } };
			expect(manifestFromPackageJson(piPkg)).toEqual({ version: "3.0.0", name: "p" });

			const nonePkg: ManifestHolder<unknown> & { name: string } = { name: "other-pkg" };
			expect(manifestFromPackageJson(nonePkg)).toBeUndefined();

			// Null / undefined safety
			expect(manifestFromPackageJson(null)).toBeUndefined();
			expect(manifestFromPackageJson(undefined)).toBeUndefined();
			expect(manifestFromPackageJson(123 as unknown as ManifestHolder<unknown>)).toBeUndefined();
		});
	});

	describe("2. Plugin Specifier Parser & Formatter", () => {
		it("parses and formats unbracketed, bracketed, wildcard, and empty features", () => {
			const cases: Array<{ input: string; expected: ParsedPluginSpec; formatted: string }> = [
				{
					input: "my-plugin",
					expected: { packageName: "my-plugin", features: null },
					formatted: "my-plugin",
				},
				{
					input: "my-plugin[search,web]",
					expected: { packageName: "my-plugin", features: ["search", "web"] },
					formatted: "my-plugin[search,web]",
				},
				{
					input: "my-plugin[*]",
					expected: { packageName: "my-plugin", features: "*" },
					formatted: "my-plugin[*]",
				},
				{
					input: "my-plugin[]",
					expected: { packageName: "my-plugin", features: [] },
					formatted: "my-plugin[]",
				},
				{
					input: "@scope/plugin@1.2.3[feat-a, feat-b]",
					expected: { packageName: "@scope/plugin@1.2.3", features: ["feat-a", "feat-b"] },
					formatted: "@scope/plugin@1.2.3[feat-a,feat-b]",
				},
				{
					input: "malformed[bracket",
					expected: { packageName: "malformed[bracket", features: null },
					formatted: "malformed[bracket",
				},
			];

			for (const c of cases) {
				const parsed = parsePluginSpec(c.input);
				expect(parsed).toEqual(c.expected);
				expect(formatPluginSpec(parsed)).toBe(c.formatted);
			}
		});

		it("extracts base package name from npm specifiers with or without scopes and versions", () => {
			expect(extractPackageName("lodash@4.17.21")).toBe("lodash");
			expect(extractPackageName("@scope/pkg@1.0.0")).toBe("@scope/pkg");
			expect(extractPackageName("@scope/pkg")).toBe("@scope/pkg");
			expect(extractPackageName("npm:lodash@1.0.0")).toBe("lodash");
			expect(extractPackageName("npm:@scope/pkg@2.0.0")).toBe("@scope/pkg");
			expect(extractPackageName("plain-pkg")).toBe("plain-pkg");
		});
	});

	describe("3. Plugin ID Validation & Parsing", () => {
		it("validates name segments strictly", () => {
			expect(isValidNameSegment("valid-name-123")).toBe(true);
			expect(isValidNameSegment("a")).toBe(true);
			expect(isValidNameSegment("my.plugin.name")).toBe(true);

			expect(isValidNameSegment("")).toBe(false);
			expect(isValidNameSegment("-leading-dash")).toBe(false);
			expect(isValidNameSegment("trailing-dash-")).toBe(false);
			expect(isValidNameSegment("UPPERCASE")).toBe(false);
			expect(isValidNameSegment("spaces in name")).toBe(false);
			expect(isValidNameSegment("a".repeat(65))).toBe(false);
		});

		it("builds and parses canonical name@marketplace IDs", () => {
			const id = buildPluginId("search-tool", "official-market");
			expect(id).toBe("search-tool@official-market");
			expect(parsePluginId(id)).toEqual({ name: "search-tool", marketplace: "official-market" });

			expect(parsePluginId("no-at-sign")).toBeNull();
			expect(parsePluginId("@marketplace-only")).toBeNull();
			expect(parsePluginId("plugin-only@")).toBeNull();
			expect(parsePluginId("invalid name@marketplace")).toBeNull();
			expect(parsePluginId("valid@invalid marketplace")).toBeNull();
			expect(parsePluginId("a@b@c")).toBeNull();

			expect(() => buildPluginId("INVALID", "market")).toThrow(/Invalid plugin name/);
			expect(() => buildPluginId("valid", "INVALID")).toThrow(/Invalid marketplace name/);
			expect(() => buildPluginId("a".repeat(64), "b".repeat(64))).toThrow(/exceeds 128/);
		});
	});

	describe("4. Git URL & Shorthand Parsing", () => {
		it("recognizes and parses namespaced shorthands", () => {
			for (const [prefix, host] of Object.entries(SHORTHAND_PREFIXES)) {
				const spec = `${prefix}:owner/repo#v1.2.3`;
				expect(isGitSpec(spec)).toBe(true);
				const parsed = parseGitUrl(spec);
				expect(parsed).not.toBeNull();
				expect(parsed!.type).toBe("git");
				expect(parsed!.host).toBe(host);
				expect(parsed!.path).toBe("owner/repo");
				expect(parsed!.ref).toBe("v1.2.3");
				expect(parsed!.pinned).toBe(true);
			}
		});

		it("parses protocol URLs, git+ prefixes, and scp-like ssh syntax", () => {
			const httpsUrl = "https://github.com/santhreal/veyyon#main";
			expect(parseGitUrl(httpsUrl)).toEqual({
				type: "git",
				repo: "https://github.com/santhreal/veyyon#main",
				host: "github.com",
				path: "santhreal/veyyon",
				ref: "main",
				pinned: true,
			});

			const gitPlusUrl = "git+https://gitlab.com/group/subgroup/project.git";
			const parsedGitlab = parseGitUrl(gitPlusUrl);
			expect(parsedGitlab?.host).toBe("gitlab.com");
			expect(parsedGitlab?.path).toBe("group/subgroup/project");

			const scpUrl = "git:git@github.com:user/my-repo.git#feat";
			const parsedScp = parseGitUrl(scpUrl);
			expect(parsedScp?.host).toBe("github.com");
			expect(parsedScp?.path).toBe("user/my-repo");
			expect(parsedScp?.ref).toBe("feat");
		});

		it("rejects non-git specs and decodes percent-encoded ref tags safely", () => {
			expect(isGitSpec("plain-npm-package")).toBe(false);
			expect(isGitSpec("@scope/npm-package@1.0.0")).toBe(false);

			const encodedUrl = "https://github.com/user/repo#release%2Fv1.0.0";
			const parsed = parseGitUrl(encodedUrl);
			expect(parsed?.ref).toBe("release/v1.0.0");
		});
	});

	describe("5. Extensibility Load Failure Diagnostic Messages", () => {
		it("provides standardized 3-part diagnosis: what happened, inactive effect, and remedy", () => {
			const kinds: ExtensibilityArtifact[] = ["extension", "hook", "custom command", "custom tool"];
			for (const kind of kinds) {
				const importErr = moduleImportFailedMessage(kind, "SyntaxError: Unexpected token");
				expect(importErr).toContain(`Importing this ${kind} threw`);
				expect(importErr).toContain("so it is not active in this run");
				expect(importErr).toContain("Fix:");

				const missingFactory = factoryExportMissingMessage(kind);
				expect(missingFactory).toContain(`This ${kind} has no default export that is a function`);
				expect(missingFactory).toContain("so it is not active in this run");
				expect(missingFactory).toContain("Fix:");

				const conflict = nameConflictMessage(kind, "my_tool", "a built-in tool");
				expect(conflict).toContain('The name "my_tool" is already taken by a built-in tool');
				expect(conflict).toContain(`so this ${kind} is not active in this run`);
				expect(conflict).toContain("Fix:");

				const invalidField = invalidArtifactFieldMessage(kind, "name", "must be non-empty string");
				expect(invalidField).toContain(`This ${kind} has no usable \`name\``);
				expect(invalidField).toContain("so it is not active in this run");
				expect(invalidField).toContain("Fix:");
			}
		});
	});

	describe("6. Installed Plugins Registry & Marketplace Cache Lifecycle", () => {
		const emptyReg: InstalledPluginsRegistry = { version: 2, plugins: {} };
		const sampleEntry: InstalledPluginEntry = {
			scope: "user",
			installPath: "/path/to/cache/plugins/mkt___plugin-a___1.0.0",
			version: "1.0.0",
			installedAt: "2026-01-01T00:00:00.000Z",
			lastUpdated: "2026-01-01T00:00:00.000Z",
			enabled: true,
		};

		it("adds, queries, and removes installed plugin entries immutably", () => {
			const withA = addInstalledPlugin(emptyReg, "plugin-a@market", sampleEntry);
			expect(getInstalledPlugin(withA, "plugin-a@market")).toEqual([sampleEntry]);

			const sampleEntry2: InstalledPluginEntry = { ...sampleEntry, version: "1.1.0", scope: "project" };
			const withTwo = addInstalledPlugin(withA, "plugin-a@market", sampleEntry2);
			expect(getInstalledPlugin(withTwo, "plugin-a@market")).toEqual([sampleEntry, sampleEntry2]);

			const otherEntry: InstalledPluginEntry = { ...sampleEntry, installPath: "/path/b" };
			const withBoth = addInstalledPlugin(withTwo, "plugin-b@market", otherEntry);

			// Removing plugin-a releases plugin-a without losing plugin-b
			const afterRemoval = removeInstalledPlugin(withBoth, "plugin-a@market");
			expect(getInstalledPlugin(afterRemoval, "plugin-a@market")).toBeUndefined();
			expect(getInstalledPlugin(afterRemoval, "plugin-b@market")).toEqual([otherEntry]);

			// Attempting to remove non-existent plugin throws and leaves registry untouched
			expect(() => removeInstalledPlugin(afterRemoval, "non-existent@market")).toThrow(/not found/);
			expect(getInstalledPlugin(afterRemoval, "plugin-b@market")).toEqual([otherEntry]);
		});

		it("collectReferencedPaths aggregates and deduplicates paths across registries", () => {
			const reg1 = addInstalledPlugin(emptyReg, "p1@m", { ...sampleEntry, installPath: "/path/1" });
			const reg2 = addInstalledPlugin(emptyReg, "p2@m", { ...sampleEntry, installPath: "/path/2" });

			const referenced = collectReferencedPaths(reg1, reg2, reg1);
			expect(referenced.has("/path/1")).toBe(true);
			expect(referenced.has("/path/2")).toBe(true);
			expect(referenced.size).toBe(2);
		});

		it("validates cache versions and prevents path traversal", () => {
			expect(isValidVersionForCache("1.0.0")).toBe(true);
			expect(isValidVersionForCache("2.1.0-beta.1+sha.abc")).toBe(true);

			expect(isValidVersionForCache("")).toBe(false);
			expect(isValidVersionForCache("..")).toBe(false);
			expect(isValidVersionForCache("1.0..0")).toBe(false);
			expect(isValidVersionForCache("a/b")).toBe(false);
			expect(isValidVersionForCache("v1;rm -rf /")).toBe(false);

			expect(getCachedPluginPath("/cache", "market", "plugin", "1.0.0")).toBe(
				path.join("/cache", "market___plugin___1.0.0"),
			);
			expect(() => getCachedPluginPath("/cache", "INVALID", "plugin", "1.0.0")).toThrow();
			expect(() => getCachedPluginPath("/cache", "market", "INVALID", "1.0.0")).toThrow();
			expect(() => getCachedPluginPath("/cache", "market", "plugin", "../traversal")).toThrow();
		});

		it("adds, gets, and removes marketplace registry entries without corrupting state", () => {
			const initialMarket: MarketplacesRegistry = { version: 1, marketplaces: [] };
			const mkt1: MarketplaceRegistryEntry = {
				name: "official",
				sourceType: "local",
				sourceUri: "/uri1",
				catalogPath: "/cat1.json",
				addedAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			const mkt2: MarketplaceRegistryEntry = { ...mkt1, name: "community", sourceUri: "/uri2" };

			const regWith1 = addMarketplaceEntry(initialMarket, mkt1);
			expect(getMarketplaceEntry(regWith1, "official")).toEqual(mkt1);

			// Duplicate add fails loud without state corruption
			expect(() => addMarketplaceEntry(regWith1, mkt1)).toThrow(/already exists/);

			const regWithBoth = addMarketplaceEntry(regWith1, mkt2);
			expect(getMarketplaceEntry(regWithBoth, "official")).toEqual(mkt1);
			expect(getMarketplaceEntry(regWithBoth, "community")).toEqual(mkt2);

			// Removing mkt1 leaves mkt2 intact
			const afterRemove = removeMarketplaceEntry(regWithBoth, "official");
			expect(getMarketplaceEntry(afterRemove, "official")).toBeUndefined();
			expect(getMarketplaceEntry(afterRemove, "community")).toEqual(mkt2);

			// Removing missing entry fails loud without altering registry
			expect(() => removeMarketplaceEntry(afterRemove, "missing")).toThrow(/not found/);
			expect(getMarketplaceEntry(afterRemove, "community")).toEqual(mkt2);
		});

		it("reads and writes installed plugins registry from disk safely", async () => {
			const tempDir = TempDir.createSync("@test-installed-reg-");
			try {
				const regPath = path.join(tempDir.path(), "installed_plugins.json");

				// Non-existent file returns empty registry
				const nonExistent = await readInstalledPluginsRegistry(regPath);
				expect(nonExistent).toEqual({ version: 2, plugins: {} });

				// Invalid content returns empty registry
				fs.writeFileSync(regPath, "invalid json");
				const invalid = await readInstalledPluginsRegistry(regPath);
				expect(invalid).toEqual({ version: 2, plugins: {} });

				// Write and read round trip
				const toWrite: InstalledPluginsRegistry = {
					version: 2,
					plugins: { "plugin-a@market": [sampleEntry] },
				};
				await writeInstalledPluginsRegistry(regPath, toWrite);
				const readBack = await readInstalledPluginsRegistry(regPath);
				expect(readBack).toEqual(toWrite);
			} finally {
				tempDir.removeSync();
			}
		});

		it("reads and writes marketplaces registry from disk safely", async () => {
			const tempDir = TempDir.createSync("@test-market-reg-");
			try {
				const regPath = path.join(tempDir.path(), "known_marketplaces.json");

				// Non-existent returns default empty
				const nonExistent = await readMarketplacesRegistry(regPath);
				expect(nonExistent).toEqual({ version: 1, marketplaces: [] });

				// Invalid content returns default empty
				fs.writeFileSync(regPath, "{ not json");
				const invalid = await readMarketplacesRegistry(regPath);
				expect(invalid).toEqual({ version: 1, marketplaces: [] });

				// Write and read round trip
				const toWrite: MarketplacesRegistry = {
					version: 1,
					marketplaces: [
						{
							name: "official",
							sourceType: "local",
							sourceUri: "/uri",
							catalogPath: "/cat.json",
							addedAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
				};
				await writeMarketplacesRegistry(regPath, toWrite);
				const readBack = await readMarketplacesRegistry(regPath);
				expect(readBack).toEqual(toWrite);
			} finally {
				tempDir.removeSync();
			}
		});

		it("manages marketplace cache directories, verifies caching, and cleans orphans", async () => {
			const tempDir = TempDir.createSync("@test-cache-");
			try {
				const cacheDir = path.join(tempDir.path(), "cache");
				const sourceDir = path.join(tempDir.path(), "source-plugin");
				fs.mkdirSync(sourceDir, { recursive: true });
				fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({ name: "my-plugin" }));

				expect(isCached(cacheDir, "market", "my-plugin", "1.0.0")).toBe(false);

				const cachedPath = await cachePlugin(sourceDir, cacheDir, "market", "my-plugin", "1.0.0");
				expect(fs.existsSync(cachedPath)).toBe(true);
				expect(isCached(cacheDir, "market", "my-plugin", "1.0.0")).toBe(true);

				// Re-caching is idempotent
				const recachedPath = await cachePlugin(sourceDir, cacheDir, "market", "my-plugin", "1.0.0");
				expect(recachedPath).toBe(cachedPath);
				expect(isCached(cacheDir, "market", "my-plugin", "1.0.0")).toBe(true);

				// cleanOrphanedCache retains referenced paths and removes unreferenced
				const referenced = new Set([cachedPath]);
				const cleanResult1 = await cleanOrphanedCache(cacheDir, referenced);
				expect(cleanResult1.removed).toBe(0);
				expect(isCached(cacheDir, "market", "my-plugin", "1.0.0")).toBe(true);

				const cleanResult2 = await cleanOrphanedCache(cacheDir, new Set<string>());
				expect(cleanResult2.removed).toBe(1);
				expect(isCached(cacheDir, "market", "my-plugin", "1.0.0")).toBe(false);

				// cleanOrphanedCache on non-existent dir returns { removed: 0 }
				const cleanNonExistent = await cleanOrphanedCache("/non/existent/cache/dir", new Set());
				expect(cleanNonExistent).toEqual({ removed: 0 });

				// removeCachedPlugin is a no-op on absent cache
				await removeCachedPlugin(cacheDir, "market", "my-plugin", "1.0.0");
			} finally {
				tempDir.removeSync();
			}
		});
	});

	describe("7. Plugin Runtime Config Normalization", () => {
		it("normalizes empty, partial, corrupt, or legacy lockfile configs", () => {
			expect(normalizePluginRuntimeConfig(null)).toEqual({ plugins: {}, settings: {} });
			expect(normalizePluginRuntimeConfig(undefined)).toEqual({ plugins: {}, settings: {} });
			expect(normalizePluginRuntimeConfig({})).toEqual({ plugins: {}, settings: {} });

			const partial = {
				plugins: {
					"plugin-a": { version: "1.0.0", enabledFeatures: ["feat"], enabled: true },
				},
			};
			expect(normalizePluginRuntimeConfig(partial)).toEqual({
				plugins: partial.plugins,
				settings: {},
			});

			const withSettings = {
				plugins: {},
				settings: { "plugin-a": { key: "value" } },
			};
			expect(normalizePluginRuntimeConfig(withSettings)).toEqual(withSettings);

			const corrupt = {
				plugins: "not an object" as unknown as PluginRuntimeConfig["plugins"],
				settings: null as unknown as PluginRuntimeConfig["settings"],
			};
			expect(normalizePluginRuntimeConfig(corrupt)).toEqual({ plugins: {}, settings: {} });
		});
	});

	describe("8. Contribution Registry & Lifecycle State Preservation", () => {
		it("preserves message conversion after repeated registration and a conflicting role", () => {
			// Registration has no removal API, so exercise its lifetime in a separate process.
			const output = execFileSync(
				process.execPath,
				[path.join(import.meta.dirname, "fixtures/message-kind-registration.ts")],
				{ encoding: "utf8", timeout: 10_000 },
			);
			expect(JSON.parse(output)).toEqual({
				roles: ["user"],
				text: "registered message",
				messages: [{ role: "user", content: "registered message", timestamp: 0 }],
				collision:
					'message role "user" already has a kind; a role is declared by one domain manifest\'s messageKinds',
			});
		});

		it("fails loud with actionable diagnosis when querying an undeclared role", () => {
			expect(() => agentMessageKind("undeclaredRole" as unknown as AgentMessage["role"])).toThrow(
				/no message kind for role "undeclaredRole"/,
			);
		});
	});

	describe("9. Tool Proxy & Legacy Definition Markers", () => {
		it("applyToolProxy binds methods with preserved this and forwards properties over prototype chain", () => {
			class BaseTool {
				baseVal = 42;
				getBase(): number {
					return this.baseVal;
				}
			}
			class DerivedTool extends BaseTool {
				name = "custom_tool";
				execute(arg: number): number {
					return this.getBase() + arg;
				}
			}

			const toolInstance = new DerivedTool();
			interface ProxyShape {
				name?: string;
				execute?: (arg: number) => number;
				getBase?: () => number;
			}
			const proxy: ProxyShape = {};
			applyToolProxy(toolInstance, proxy);

			expect(proxy.name).toBe("custom_tool");
			expect(proxy.execute?.(8)).toBe(50);
			expect(proxy.getBase?.()).toBe(42);
		});

		it("exports the legacy tool definition marker constant", () => {
			expect(LEGACY_TOOL_DEFINITION_MARKER).toBe("__isToolDefinition");
		});
	});

	describe("10. TypeBox Compatibility Shim Validation", () => {
		it("validates objects, primitives, string code point lengths, and formats", () => {
			const schema = Type.Object({
				name: Type.String({ minLength: 2, maxLength: 5 }),
				count: Type.Number({ minimum: 0, maximum: 10 }),
				enabled: Type.Boolean(),
				tag: Type.Optional(Type.String()),
			});

			const validData = { name: "test", count: 5, enabled: true };
			const parseRes = schema.safeParse(validData);
			expect(parseRes.success).toBe(true);
			if (parseRes.success) expect(parseRes.data).toEqual(validData);

			// Astral Unicode character (emoji is 1 code point, 2 UTF-16 units)
			const emojiStr = "🚀🚀🚀"; // 3 code points
			const emojiRes = schema.safeParse({ name: emojiStr, count: 1, enabled: false });
			expect(emojiRes.success).toBe(true);

			// Exceeds max length
			const tooLongRes = schema.safeParse({ name: "toolongname", count: 1, enabled: false });
			expect(tooLongRes.success).toBe(false);

			// IPv6 formats
			const ipv6Schema = Type.String({ format: "ipv6" });
			expect(ipv6Schema.safeParse("::1").success).toBe(true);
			expect(ipv6Schema.safeParse("fe80::1").success).toBe(true);
			expect(ipv6Schema.safeParse("2001:0db8:85a3:0000:0000:8a2e:0370:7334").success).toBe(true);
			expect(ipv6Schema.safeParse("invalid:::ipv6").success).toBe(false);
		});

		it("validates StringEnum compatibility schemas across arrays, records, and options", () => {
			const arraySchema = StringEnum(["small", "medium", "large"], {
				description: "T-shirt size",
				default: "medium",
			});
			const validArray = arraySchema.safeParse("medium");
			expect(validArray.success).toBe(true);
			if (validArray.success) expect(validArray.data).toBe("medium");

			const invalidArray = arraySchema.safeParse("extra-large");
			expect(invalidArray.success).toBe(false);

			const Direction = { Up: "up", Down: "down" } as const;
			const recordSchema = StringEnum(Direction);
			expect(recordSchema.safeParse("up").success).toBe(true);
			expect(recordSchema.safeParse("left").success).toBe(false);
		});
	});
});
