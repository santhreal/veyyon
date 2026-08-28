/**
 * WHY: `veyyon plugin install <spec> --dry-run` reported success for a target that
 * could not be installed at all (#911). `PluginManager.install` returned a
 * fabricated `0.0.0-dryrun` record after checking only that the spec was
 * *spelled* like a package name, so an unpublished npm name and a missing git
 * repository both printed "Would install" and exited 0. `--json` was worse: it
 * emitted a complete plugin record, `enabled: true` included, for a package that
 * does not exist.
 *
 * THE CLASS THIS CLOSES: a dry run that answers from the spec string instead of
 * from resolution. `PluginManager.install(..., { dryRun: true })` is the choke
 * point for the npm and git spec forms, so their invariants are asserted there
 * once rather than per spec form:
 *
 *   1. the dry run asks bun to resolve, passing `--dry-run`;
 *   2. a resolution failure throws, for EVERY spec form;
 *   3. a resolution success reports the name and version bun resolved, never the
 *      spec and never a placeholder;
 *   4. the dry run writes nothing.
 *
 * The git spec forms are swept from `SHORTHAND_PREFIXES` at run time, so adding a
 * host without deciding what its dry run does turns this suite red.
 *
 * WHAT IT DOES NOT CATCH: bun's own resolver is mocked, so this proves veyyon
 * reacts correctly to bun's exit code and summary line, not that bun resolves any
 * particular registry or host correctly. It also does not prove a resolved target
 * is a veyyon plugin: a dry run never unpacks the package, so its manifest is
 * unreadable at that point and only the version is reported.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ClassifiedInstallTarget, classifyInstallTarget } from "@veyyon/coding-agent/cli/classify-install-target";
import { runPluginCommand } from "@veyyon/coding-agent/cli/plugin-cli";
import { SHORTHAND_PREFIXES } from "@veyyon/coding-agent/extensibility/plugins/git-url";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins/manager";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as piUtils from "@veyyon/utils";
import { removeWithRetries } from "@veyyon/utils";
import type { Subprocess } from "bun";

function stream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) {
		throw new Error("Failed to create response stream");
	}
	return body;
}

// The real `Bun.spawn`, captured before any spy exists. Non-`bun` spawns (the
// CPU-limit support probe routes `node:child_process` through here) must reach it.
const realBunSpawn = Bun.spawn;

/** Every `bun …` argv the manager issued during a case. */
let spawned: string[][];

/**
 * Answer the manager's `bun …` invocations with a fixed exit code and stdout,
 * delegating every other spawn to the real implementation.
 */
function mockBun(exitCode: number, stdout: string, stderr = ""): void {
	vi.spyOn(Bun, "spawn").mockImplementation(((first: unknown, options?: unknown) => {
		if (!Array.isArray(first) || first[0] !== "bun") {
			return (realBunSpawn as unknown as (cmd: unknown, options?: unknown) => Subprocess)(first, options);
		}
		spawned.push(first as string[]);
		return {
			pid: 1,
			stdout: stream(stdout),
			stderr: stream(stderr),
			exited: Promise.resolve(exitCode),
		} as Subprocess;
	}) as typeof Bun.spawn);
}

/** Spec forms a dry run must resolve: one npm spec plus every git shorthand. */
function specForms(): { label: string; spec: string }[] {
	const forms = [{ label: "npm", spec: "some-plugin" }];
	for (const prefix of Object.keys(SHORTHAND_PREFIXES)) {
		forms.push({ label: `${prefix}: shorthand`, spec: `${prefix}:owner/repo` });
	}
	forms.push({ label: "https git url", spec: "https://github.com/owner/repo" });
	return forms;
}

describe("a dry-run install resolves the target", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;

	beforeEach(async () => {
		spawned = [];
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-plugin-dryrun-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		pluginsPkgJson = path.join(pluginsDir, "package.json");
		await fs.mkdir(pluginsNodeModules, { recursive: true });
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "veyyon-plugins", private: true, dependencies: {} }, null, 2),
		);

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(pluginsPkgJson);
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "veyyon-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	// The defect itself: resolution failure had no way to reach the caller,
	// because nothing was resolved. Swept across every spec form, since the
	// original bug returned the placeholder before looking at the spec's shape.
	for (const { label, spec } of specForms()) {
		test(`rejects an unresolvable ${label} target instead of reporting success`, async () => {
			mockBun(1, "", `error: GET https://registry.npmjs.org/${spec} - 404`);

			const mgr = new PluginManager(tmpRoot);
			await expect(mgr.install(spec, { dryRun: true })).rejects.toThrow(/cannot be installed/);
		});

		test(`asks bun to resolve the ${label} target with --dry-run`, async () => {
			mockBun(0, "installed some-plugin@1.0.0\n");

			const mgr = new PluginManager(tmpRoot);
			await mgr.install(spec, { dryRun: true });

			// Exactly one bun invocation, and it must carry --dry-run: without the
			// flag this would be a real install behind a dry-run request.
			expect(spawned.length).toBe(1);
			expect(spawned[0][0]).toBe("bun");
			expect(spawned[0][1]).toBe("install");
			expect(spawned[0]).toContain("--dry-run");
		});
	}

	test("reports the version bun resolved, not a placeholder", async () => {
		mockBun(0, "installed some-plugin@4.9.0\n");

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("some-plugin", { dryRun: true });

		expect(result.name).toBe("some-plugin");
		expect(result.version).toBe("4.9.0");
		expect(result.manifest.version).toBe("4.9.0");
	});

	test("reports the scoped name bun resolved when the summary carries a binaries suffix", async () => {
		mockBun(0, "installed @scope/some-plugin@0.73.1 with binaries:\n - some-plugin\n");

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("@scope/some-plugin", { dryRun: true });

		// The `@` at index 0 opens the scope; the separator is the next one.
		expect(result.name).toBe("@scope/some-plugin");
		expect(result.version).toBe("0.73.1");
	});

	test("reports the package name a git spec resolves to, which the spec never states", async () => {
		// The real defect this closes for git: `github:sindresorhus/slugify`
		// resolves to `@sindresorhus/slugify`, a name not derivable from the spec.
		mockBun(0, "installed @owner/real-name@github:owner/repo#7c318bd\n");

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("github:owner/repo", { dryRun: true });

		expect(result.name).toBe("@owner/real-name");
		expect(result.version).toBe("github:owner/repo#7c318bd");
	});

	test("never surfaces the 0.0.0-dryrun placeholder the defect returned", async () => {
		mockBun(0, "installed some-plugin@1.2.3\n");

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("some-plugin", { dryRun: true });

		expect(result.version).not.toBe("0.0.0-dryrun");
		expect(result.manifest.version).not.toBe("0.0.0-dryrun");
		expect(JSON.stringify(result)).not.toContain("dryrun");
	});

	test("degrades to an empty version rather than failing when bun prints no summary", async () => {
		// A bun output change must not turn a target bun resolved into an error.
		mockBun(0, "");

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("some-plugin", { dryRun: true });

		expect(result.name).toBe("some-plugin");
		expect(result.version).toBe("");
	});

	test("writes no dependency, lockfile or node_modules entry", async () => {
		mockBun(0, "installed some-plugin@1.0.0\n");

		const before = await fs.readFile(pluginsPkgJson, "utf8");
		const mgr = new PluginManager(tmpRoot);
		await mgr.install("some-plugin", { dryRun: true });

		expect(await fs.readFile(pluginsPkgJson, "utf8")).toBe(before);
		expect(await fs.readdir(pluginsNodeModules)).toEqual([]);
		await expect(fs.access(path.join(pluginsDir, "bun.lock"))).rejects.toThrow();
	});

	test("a malformed spec still fails before bun is invoked at all", async () => {
		// Syntax validation runs first and must keep doing so: an injection-shaped
		// spec must never reach a spawned command, dry run or not.
		mockBun(0, "installed some-plugin@1.0.0\n");

		const mgr = new PluginManager(tmpRoot);
		await expect(mgr.install("not a real spec!!", { dryRun: true })).rejects.toThrow(/not a valid npm package name/);
		expect(spawned.length).toBe(0);
	});
});

/**
 * WHY (second defect, same class): the suite above pins its invariants at
 * `PluginManager.install(..., { dryRun: true })`, and the CLI was documented as
 * funnelling every dry run through it. It did not. `handleInstall` classifies a
 * spec into three targets and only two reached that method: a `name@marketplace`
 * spec went straight to `MarketplaceManager.installPlugin` with `flags.dryRun`
 * never read, so `--dry-run` copied the plugin into the cache, wrote both
 * registries and printed "Installed". The same lie as #911, one branch over.
 *
 * THE CLASS THIS CLOSES: a `--dry-run` branch that performs the real work. These
 * cases drive the CLI, because the branch lives at the CLI, and they assert the
 * plugins tree byte-for-byte rather than which method was called. The control
 * case runs the same spec without `--dry-run` and requires the tree to change,
 * so a snapshot that could never differ cannot pass by accident.
 *
 * `DRY_RUN_COVERAGE` is keyed by `ClassifiedInstallTarget["type"]`, so adding a
 * fourth install target fails to type-check until someone records what its dry
 * run does, and the sweep fails if the corpus can reach a type the record omits.
 *
 * WHAT IT DOES NOT CATCH: the npm branch's resolution is proven above against a
 * mocked bun and is not re-driven here, so this says nothing about how a real
 * registry answers. It also does not cover `plugin upgrade`, which has no dry
 * run at all.
 */
describe("a marketplace dry run installs nothing", () => {
	const MARKETPLACE = "test-marketplace";
	const PLUGIN = "hello-plugin";

	let tmpRoot: string;
	let configRoot: string;
	let pluginsDir: string;
	let sourceDir: string;
	let out: string[];
	let err: string[];

	beforeAll(async () => {
		// The marketplace failure branch renders through the theme.
		await initTheme();
	});

	/** Every path under the plugins tree, sorted — the whole disk surface an install writes to. */
	async function pluginsTree(): Promise<string[]> {
		const entries = await fs.readdir(pluginsDir, { recursive: true });
		return entries.sort();
	}

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-marketplace-dryrun-"));
		configRoot = path.join(tmpRoot, "config");
		pluginsDir = path.join(tmpRoot, "plugins");
		sourceDir = path.join(tmpRoot, "marketplace-src");

		const pluginSrc = path.join(sourceDir, "plugins", PLUGIN);
		await fs.mkdir(path.join(pluginSrc, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });
		await fs.mkdir(configRoot, { recursive: true });
		await Bun.write(
			path.join(pluginSrc, "package.json"),
			JSON.stringify({ name: PLUGIN, version: "1.0.0", veyyon: { extensions: [] } }),
		);
		await Bun.write(
			path.join(pluginSrc, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: PLUGIN, version: "1.0.0" }),
		);

		const catalog = JSON.stringify({
			name: MARKETPLACE,
			owner: { name: "Test Author", email: "test@example.com" },
			metadata: { description: "A catalog with one plugin", version: "1.0.0" },
			plugins: [{ name: PLUGIN, source: `./plugins/${PLUGIN}`, description: "greets", version: "1.0.0" }],
		});
		await Bun.write(path.join(sourceDir, ".claude-plugin", "marketplace.json"), catalog);

		// The registry points at the cached catalog copy, which is where a real
		// `marketplace add` leaves it. Inside pluginsDir, so both snapshots see it.
		const catalogPath = path.join(pluginsDir, "cache", "marketplaces", MARKETPLACE, "marketplace.json");
		await Bun.write(catalogPath, catalog);
		await Bun.write(
			path.join(configRoot, "marketplaces.json"),
			JSON.stringify({
				version: 1,
				marketplaces: [
					{
						name: MARKETPLACE,
						sourceType: "local",
						sourceUri: sourceDir,
						catalogPath,
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);

		vi.spyOn(piUtils, "getConfigRootDir").mockReturnValue(configRoot);
		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "veyyon-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));

		out = [];
		err = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(stripVTControlCharacters(args.join(" ")));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			err.push(stripVTControlCharacters(args.join(" ")));
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	test("reports the version the catalog resolves and leaves the plugins tree untouched", async () => {
		const before = await pluginsTree();

		await runPluginCommand({ action: "install", args: [`${PLUGIN}@${MARKETPLACE}`], flags: { dryRun: true } });

		// The version can only come from the catalog, so echoing the spec back fails here.
		expect(out).toEqual([`[dry-run] Would install ${PLUGIN}@1.0.0 from ${MARKETPLACE}`]);
		expect(await pluginsTree()).toEqual(before);
	});

	test("--json names the resolved version and still writes nothing", async () => {
		const before = await pluginsTree();

		await runPluginCommand({
			action: "install",
			args: [`${PLUGIN}@${MARKETPLACE}`],
			flags: { dryRun: true, json: true },
		});

		expect(JSON.parse(out.join("\n"))).toEqual({
			dryRun: true,
			action: "install",
			name: PLUGIN,
			marketplace: MARKETPLACE,
			version: "1.0.0",
		});
		expect(await pluginsTree()).toEqual(before);
	});

	// Control: the same spec without --dry-run must change the tree. Without this
	// the snapshot assertions above would pass even if an install could never write.
	test("the same spec without --dry-run writes the cache and the registry", async () => {
		const before = await pluginsTree();

		await runPluginCommand({ action: "install", args: [`${PLUGIN}@${MARKETPLACE}`], flags: {} });

		const after = await pluginsTree();
		expect(after).not.toEqual(before);
		expect(after).toContain("installed_plugins.json");
		expect(after).toContain(path.join("cache", "plugins", `${MARKETPLACE}___${PLUGIN}___1.0.0`, "package.json"));
		expect(after).toContain(path.join("node_modules", PLUGIN, "package.json"));
	});

	test("a plugin the catalog does not list fails loud instead of reporting a plan", async () => {
		const before = await pluginsTree();
		// The stub is what makes a process exit observable in-process; the assertions below read the
		// exit code out of the thrown message, the operator-visible wording, and the untouched tree.
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as (code?: number) => never);

		await expect(
			runPluginCommand({ action: "install", args: [`ghost@${MARKETPLACE}`], flags: { dryRun: true } }),
		).rejects.toThrow("process.exit(1)");

		expect(err.join("\n")).toContain(`${MARKETPLACE} lists no plugin named ghost`);
		expect(out).toEqual([]);
		expect(await pluginsTree()).toEqual(before);
	});

	// Fail-by-default: a fourth `ClassifiedInstallTarget` member breaks the type of
	// this record until its dry-run behaviour is recorded, and the sweep breaks if a
	// spec shape can classify into a type the record omits.
	const DRY_RUN_COVERAGE: Record<ClassifiedInstallTarget["type"], string> = {
		local: "prints [dry-run] Would link and calls neither link nor install (plugin-install-local.test.ts)",
		marketplace: "resolves through the catalog and writes nothing (this describe)",
		npm: "resolves through bun --dry-run and writes nothing (the describe above)",
	};

	test("every target a spec can classify into has a recorded dry-run behaviour", () => {
		const corpus = [
			"./local",
			"/abs/local",
			`${PLUGIN}@${MARKETPLACE}`,
			"some-pkg",
			"@scope/pkg",
			"pkg@1.2.3",
			"pkg@latest",
		];
		const reached = new Set<string>(corpus.map(spec => classifyInstallTarget(spec, new Set([MARKETPLACE])).type));

		expect([...reached].sort()).toEqual(Object.keys(DRY_RUN_COVERAGE).sort());
	});
});
