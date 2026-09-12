/**
 * A marketplace catalog entry the parser cannot install is reported to the operator, not dropped.
 *
 * WHY THIS SUITE EXISTS. `parseMarketplaceCatalog` is lenient on purpose: one malformed entry
 * costs that entry, not the marketplace, because a Claude Code catalog may list shapes this loader
 * does not install. The drop went to `logger.warn` only. `veyyon plugin marketplace add` then
 * printed its success line, `veyyon plugin discover` never listed the plugin, and the cached
 * catalog on disk had already lost the entry, so nothing an operator could run showed that the
 * catalog ever named it.
 *
 * THE CLASS THIS CLOSES. Every reason the parser drops an entry: a non-object entry, an invalid
 * name, a source that is neither a string nor a typed object, a string source without the `./`
 * prefix, a typed source missing its required field, and an unknown typed variant. Each raises one
 * fault on the shared sink that names the plugin and the failing field, and the plugin CLI prints
 * every fault raised during a command to stderr.
 *
 * WHAT IT DOES NOT CATCH. The reason list is written here by hand, since the parser has no
 * exported table of its checks; a new check that drops an entry without reporting it is caught
 * only if a row is added for it.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPluginCommand } from "@veyyon/coding-agent/cli/plugin-cli";
import { parseMarketplaceCatalog } from "@veyyon/coding-agent/extensibility/plugins/marketplace";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as piUtils from "@veyyon/utils";
import { attachFaultSink, type Fault, removeSyncWithRetries } from "@veyyon/utils";

const CATALOG_PATH = "/repo/.claude-plugin/marketplace.json";

function catalogWith(entries: unknown[]): string {
	return JSON.stringify({ name: "mkt", owner: { name: "o" }, plugins: entries });
}

/** Runs `fn` with a sink attached and returns every fault it raised, in order. */
async function faultsDuring(fn: () => Promise<void> | void): Promise<Fault[]> {
	const faults: Fault[] = [];
	const detach = attachFaultSink(fault => {
		faults.push(fault);
	});
	try {
		await fn();
	} finally {
		detach();
	}
	return faults;
}

const DROPPED_ENTRIES: Array<{ reason: string; entry: unknown; field: string; name: string }> = [
	{ reason: "a non-object entry", entry: "just-a-string", field: "plugins[0]", name: "[0]" },
	{
		reason: "an invalid name",
		entry: { name: "Bad Name!", source: "./p" },
		field: "plugins[0].name",
		name: "Bad Name!",
	},
	{ reason: "a source of the wrong type", entry: { name: "p", source: 42 }, field: "plugins[0].source", name: "p" },
	{
		reason: "a string source without ./",
		entry: { name: "p", source: "plugins/p" },
		field: 'plugins[0].source (must start with "./")',
		name: "p",
	},
	{
		reason: "a github source without repo",
		entry: { name: "p", source: { source: "github" } },
		field: "plugins[0].source.repo",
		name: "p",
	},
	{
		reason: "a url source without url",
		entry: { name: "p", source: { source: "url" } },
		field: "plugins[0].source.url",
		name: "p",
	},
	{
		reason: "a git-subdir source without path",
		entry: { name: "p", source: { source: "git-subdir", url: "https://x" } },
		field: "plugins[0].source.path",
		name: "p",
	},
	{
		reason: "an npm source without package",
		entry: { name: "p", source: { source: "npm" } },
		field: "plugins[0].source.package",
		name: "p",
	},
	{
		reason: "an unknown typed variant",
		entry: { name: "p", source: { source: "ftp" } },
		field: 'plugins[0].source.source (unknown variant: "ftp")',
		name: "p",
	},
];

describe("parseMarketplaceCatalog", () => {
	for (const row of DROPPED_ENTRIES) {
		it(`raises one marketplace fault naming the plugin and the field for ${row.reason}`, async () => {
			let catalogPlugins = -1;
			const faults = await faultsDuring(() => {
				catalogPlugins = parseMarketplaceCatalog(
					catalogWith([row.entry, { name: "ok", source: "./ok" }]),
					CATALOG_PATH,
				).plugins.length;
			});

			expect(catalogPlugins).toBe(1);
			expect(faults.map(f => f.source)).toEqual(["marketplace"]);
			expect(faults[0]?.text).toContain(`"${row.name}"`);
			expect(faults[0]?.text).toContain(row.field);
			expect(faults[0]?.text).toContain("Fix:");
		});
	}

	it("raises no fault for a catalog whose every entry is installable", async () => {
		const faults = await faultsDuring(() => {
			parseMarketplaceCatalog(catalogWith([{ name: "ok", source: "./ok" }]), CATALOG_PATH);
		});

		expect(faults).toEqual([]);
	});
});

describe("veyyon plugin marketplace add", () => {
	let tmpDir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		if (tmpDir) removeSyncWithRetries(tmpDir);
		tmpDir = undefined;
	});

	it("prints the dropped entry to stderr beside its success line", async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-mkt-add-"));
		const home = path.join(tmpDir, "home");
		const project = path.join(tmpDir, "project");
		const marketplace = path.join(tmpDir, "marketplace");
		fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(
			path.join(marketplace, ".claude-plugin", "marketplace.json"),
			catalogWith([
				{ name: "good", source: "./plugins/good" },
				{ name: "stray", source: "plugins/stray" },
			]),
		);
		spyOn(piUtils, "getConfigRootDir").mockReturnValue(home);
		spyOn(piUtils, "getPluginsDir").mockReturnValue(path.join(home, "plugins"));
		spyOn(piUtils, "getProjectDir").mockReturnValue(project);
		const stdout: string[] = [];
		const stderr: string[] = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			stdout.push(args.map(String).join(" "));
		});
		spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			stderr.push(args.map(String).join(" "));
		});

		await initTheme();
		await runPluginCommand({ action: "marketplace", args: ["add", marketplace], flags: {} });

		expect(stderr.filter(line => line.includes("Failed"))).toEqual([]);
		expect(stdout.join("\n")).toContain("Added marketplace");
		const warning = stderr.find(line => line.includes('"stray"'));
		expect(warning).toBeDefined();
		expect(warning).toContain('must start with "./"');
		expect(warning).toContain("Fix:");
	});
});
