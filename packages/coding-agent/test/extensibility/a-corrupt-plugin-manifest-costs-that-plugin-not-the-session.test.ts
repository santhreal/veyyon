/**
 * A plugin whose own `package.json` cannot be parsed loses that plugin, and nothing else.
 *
 * WHY THIS SUITE EXISTS. `collectPluginsAtRoot` rethrew every non-ENOENT failure from reading a
 * plugin's `package.json`. One corrupt manifest under `<plugins>/node_modules/<name>/` therefore
 * threw out of `getEnabledPlugins`, out of `loadExtensions`, and out of session startup: the
 * process died on a file it had not been asked to load, with a JSON parse error and no plugin
 * name. `plugin doctor`, the command that exists to find such a file, rethrew from the same spot
 * and printed nothing about the plugins it had already checked.
 *
 * THE CLASS THIS CLOSES. Every reader of the plugin roots that meets a manifest it cannot parse:
 * the enabled-plugin enumeration that feeds extensions, tools, hooks and commands, and the doctor.
 * The root's own `package.json` and lockfile are the same class one level up and are asserted too.
 * The rule is one line: a file that exists and cannot be read costs the thing it describes, is
 * reported with its path, and stops nothing else.
 *
 * WHAT IT DOES NOT CATCH. A manifest that parses and lies (a `tools` entry pointing nowhere) is
 * `plugin-doctor-reports-a-broken-install.test.ts` and `plugin-entries-that-vanish-are-reported.test.ts`.
 * The operator notice surface that the fault sink feeds is asserted through the sink, not drawn.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@veyyon/coding-agent/discovery/helpers";
import {
	getAllPluginExtensionPaths,
	getAllPluginToolPaths,
	getEnabledPlugins,
} from "@veyyon/coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins/manager";
import type { DoctorCheck } from "@veyyon/kernel/loader/plugins/types";
import * as piUtils from "@veyyon/utils";
import { attachFaultSink, type Fault } from "@veyyon/utils";

let tmpRoot: string;
let pluginsDir: string;
let nodeModules: string;
let spies: Array<{ mockRestore: () => void }>;
let faults: Fault[];
let detach: () => void;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-corrupt-plugin-manifest-"));
	pluginsDir = path.join(tmpRoot, "plugins");
	nodeModules = path.join(pluginsDir, "node_modules");
	await fs.mkdir(nodeModules, { recursive: true });
	spies = [
		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir),
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(nodeModules),
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json")),
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(pluginsDir, "veyyon-plugins.lock.json")),
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot),
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json")),
	];
	faults = [];
	detach = attachFaultSink(fault => {
		faults.push(fault);
	});
	clearClaudePluginRootsCache();
});

afterEach(async () => {
	detach();
	for (const spy of spies) spy.mockRestore();
	clearClaudePluginRootsCache();
});

/** A veyyon plugin under node_modules with one extension entry, listed in the root manifest. */
async function installPlugin(name: string, packageJson: string): Promise<void> {
	const dir = path.join(nodeModules, name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "package.json"), packageJson);
	await fs.writeFile(path.join(dir, "index.js"), "export default () => {};\n");
}

function healthyManifest(name: string): string {
	return JSON.stringify({ name, version: "1.0.0", veyyon: { extensions: ["index.js"], tools: "index.js" } });
}

async function writeRootManifest(deps: string[]): Promise<void> {
	await fs.writeFile(
		path.join(pluginsDir, "package.json"),
		JSON.stringify({ dependencies: Object.fromEntries(deps.map(name => [name, "1.0.0"])) }),
	);
}

const CORRUPT = '{"name": "broken", "version": "1.0.0", "veyyon": {';

function pluginFaults(): Fault[] {
	return faults.filter(fault => fault.source === "plugins");
}

function check(checks: DoctorCheck[], name: string): DoctorCheck | undefined {
	return checks.find(c => c.name === name);
}

describe("a plugin whose package.json cannot be parsed", () => {
	beforeEach(async () => {
		await writeRootManifest(["healthy", "broken"]);
		await installPlugin("healthy", healthyManifest("healthy"));
		await installPlugin("broken", CORRUPT);
	});

	/** THE ORIGINAL DEFECT: the throw took the whole enumeration, and with it session startup. */
	it("is skipped by the enabled-plugin enumeration, which still returns its siblings", async () => {
		const plugins = await getEnabledPlugins(tmpRoot);

		expect(plugins.map(plugin => plugin.name)).toEqual(["healthy"]);
	});

	it("is reported once, by path, with the plugin it cost and the remedy", async () => {
		await getEnabledPlugins(tmpRoot);

		const reported = pluginFaults();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.text).toContain(path.join(nodeModules, "broken", "package.json"));
		expect(reported[0]?.text).toContain("veyyon plugin install");
		expect(reported[0]?.text).toContain('Not loaded in this run: the plugin "broken"');
		expect(reported[0]?.context).toMatchObject({ path: path.join(nodeModules, "broken", "package.json") });
	});

	/**
	 * Every aggregate reader goes through the same enumeration; asserting two of them proves the
	 * skip is at the choke point rather than in one caller's catch.
	 */
	it("keeps the sibling's extension and tool entries reachable", async () => {
		const extensions = await getAllPluginExtensionPaths(tmpRoot);
		const tools = await getAllPluginToolPaths(tmpRoot);

		expect(extensions).toEqual([path.join(nodeModules, "healthy", "index.js")]);
		expect(tools).toEqual([path.join(nodeModules, "healthy", "index.js")]);
	});

	it("is an error row in plugin doctor, beside the sibling's ok row", async () => {
		const checks = await new PluginManager(tmpRoot).doctor();

		expect(check(checks, "plugin:healthy")).toMatchObject({ status: "ok" });
		expect(check(checks, "plugin:broken")).toMatchObject({ status: "error" });
		expect(check(checks, "plugin:broken")?.message).toContain("package.json cannot be read");
		expect(check(checks, "plugin:broken")?.message).toContain("veyyon plugin install");
	});
});

describe("a plugin whose package.json is absent", () => {
	/** The control: a lockfile entry whose tree was deleted is not a fault, so the report stays quiet. */
	it("is skipped in silence, as a deleted link", async () => {
		await writeRootManifest(["healthy"]);
		await installPlugin("healthy", healthyManifest("healthy"));
		await fs.writeFile(
			path.join(pluginsDir, "veyyon-plugins.lock.json"),
			JSON.stringify({ plugins: { gone: { enabled: true } } }),
		);

		const plugins = await getEnabledPlugins(tmpRoot);

		expect(plugins.map(plugin => plugin.name)).toEqual(["healthy"]);
		expect(pluginFaults()).toEqual([]);
	});
});

describe("the root's own files", () => {
	/**
	 * The same class one level up. A corrupt root `package.json` loses the dependency list, but a
	 * plugin the lockfile records is still found; a corrupt lockfile loses link and enable state,
	 * but a plugin the root manifest lists is still found. Each is reported by path.
	 */
	it("a corrupt root package.json is reported and the lockfile's plugins still load", async () => {
		await fs.writeFile(path.join(pluginsDir, "package.json"), "{ not json");
		await installPlugin("linked", healthyManifest("linked"));
		await fs.writeFile(
			path.join(pluginsDir, "veyyon-plugins.lock.json"),
			JSON.stringify({ plugins: { linked: { enabled: true } } }),
		);

		const plugins = await getEnabledPlugins(tmpRoot);

		expect(plugins.map(plugin => plugin.name)).toEqual(["linked"]);
		expect(pluginFaults().map(fault => fault.context?.path)).toEqual([path.join(pluginsDir, "package.json")]);
	});

	it("a corrupt lockfile is reported and the manifest's plugins still load", async () => {
		await writeRootManifest(["healthy"]);
		await installPlugin("healthy", healthyManifest("healthy"));
		await fs.writeFile(path.join(pluginsDir, "veyyon-plugins.lock.json"), "{ not json");

		const plugins = await getEnabledPlugins(tmpRoot);

		expect(plugins.map(plugin => plugin.name)).toEqual(["healthy"]);
		expect(pluginFaults().map(fault => fault.context?.path)).toEqual([
			path.join(pluginsDir, "veyyon-plugins.lock.json"),
		]);
	});
});
