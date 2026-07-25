/**
 * A plugin that is installed and contributes nothing must not look like a plugin with nothing to give.
 *
 * WHY THIS SUITE EXISTS. `resolveDirectoryEntries`, which backs the `extensions` key of a plugin
 * manifest, answered a failed `readdirSync` with `[]`. An empty list is also what a directory that
 * genuinely holds no loadable files produces, and the caller treats both the same way: the plugin loads,
 * registers nothing, and reports no error. So a plugin directory this process cannot read presented as a
 * plugin whose author shipped an empty folder, and the tools, hooks and commands it should have
 * registered were simply absent from the session with nothing to trace.
 *
 * The empty list is still returned. One unreadable directory must not stop the rest of the plugin, or
 * the other plugins, from loading, so the report is the entire fix and the report is what is asserted
 * here. The ABSENT case is asserted to stay silent, because that is the distinction the fix rests on:
 * this resolver is offered every path a manifest declares, including ones that do not exist, and a
 * warning there would fire during ordinary loading.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePluginManifestEntries } from "@veyyon/coding-agent/extensibility/plugins/loader";
import type { InstalledPlugin, PluginManifest } from "@veyyon/coding-agent/extensibility/plugins/types";
import { logger } from "@veyyon/utils";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

let root: string;
let warnings: Warning[];
let restore: () => void;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-plugin-entry-loss-"));
	warnings = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	restore = () => spy.mockRestore();
});

afterEach(() => {
	restore();
	fs.chmodSync(root, 0o755);
	fs.rmSync(root, { recursive: true, force: true });
});

/** The one warning this suite is about, picked out of anything else loading may log. */
function lossReports(): Warning[] {
	return warnings.filter(warning => warning.message.includes("plugin directory could not be read"));
}

/** A plugin rooted at the fixture directory, declaring one `extensions` entry. */
function pluginDeclaring(entry: string): InstalledPlugin {
	const manifest: PluginManifest = { version: "1", extensions: [entry] };
	return { name: "p", version: "1", path: root, manifest, enabledFeatures: null, enabled: true };
}

/** Resolved `extensions` entries, which is the key that expands a directory. */
function resolveExtensions(entry: string): Array<{ entry: string; resolvedPath: string | null }> {
	return resolvePluginManifestEntries(pluginDeclaring(entry), "extensions");
}

describe("a directory whose files can be read", () => {
	/** The ordinary case: the files are found, resolved to real paths, and nothing is reported. */
	it("resolves the files inside it and reports nothing", () => {
		fs.mkdirSync(path.join(root, "ext"));
		fs.writeFileSync(path.join(root, "ext", "one.js"), "// fixture");
		fs.writeFileSync(path.join(root, "ext", "two.js"), "// fixture");

		const resolved = resolveExtensions("ext").map(e => path.relative(root, e.resolvedPath ?? ""));

		expect(resolved.sort()).toEqual([path.join("ext", "one.js"), path.join("ext", "two.js")]);
		expect(lossReports()).toEqual([]);
	});
});

describe("a directory that holds nothing loadable", () => {
	/**
	 * The case the failure used to be confused with. An author who ships an empty folder, or one holding
	 * only files this loader does not accept, gets no entry and no warning: nothing was lost.
	 */
	it("resolves no entry and reports nothing for an empty directory", () => {
		fs.mkdirSync(path.join(root, "ext"));

		expect(resolveExtensions("ext")).toEqual([{ entry: "ext", resolvedPath: null }]);
		expect(lossReports()).toEqual([]);
	});

	/** Same for a directory of files with extensions the loader does not load. */
	it("resolves no entry and reports nothing when no file has a loadable extension", () => {
		fs.mkdirSync(path.join(root, "ext"));
		fs.writeFileSync(path.join(root, "ext", "README.md"), "# not code");

		expect(resolveExtensions("ext")).toEqual([{ entry: "ext", resolvedPath: null }]);
		expect(lossReports()).toEqual([]);
	});
});

describe("a declared directory that does not exist", () => {
	/**
	 * Also silent, and this is the reason the fix keys on ENOENT rather than on any failure: a manifest
	 * that names a directory it does not ship is resolved on every load, so warning here would fire
	 * constantly and train the reader to ignore the warning that matters.
	 */
	it("resolves no entry and reports nothing", () => {
		expect(resolveExtensions("no-such-dir")).toEqual([{ entry: "no-such-dir", resolvedPath: null }]);
		expect(lossReports()).toEqual([]);
	});
});

describe("a directory that exists and cannot be read", () => {
	/**
	 * The regression this exists to prevent. The plugin still loads with no entries, exactly as before,
	 * so the report is the only thing that distinguishes this from the empty-directory case above.
	 *
	 * Permission bits do not bind root, so under a root test runner the read succeeds and there is
	 * nothing to report. That branch is asserted honestly rather than skipped, so the suite never passes
	 * for the wrong reason.
	 */
	it("reports the directory and the error while still resolving no entry", () => {
		const dir = path.join(root, "ext");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "one.js"), "// fixture");
		fs.chmodSync(dir, 0o000);

		let readable = true;
		try {
			fs.readdirSync(dir);
		} catch {
			readable = false;
		}

		const resolved = resolveExtensions("ext");

		if (readable) {
			// Running as root: the mode bits were ignored, so the file is found and nothing is lost.
			expect(resolved.map(e => path.relative(root, e.resolvedPath ?? ""))).toEqual([path.join("ext", "one.js")]);
			expect(lossReports()).toEqual([]);
		} else {
			expect(resolved).toEqual([{ entry: "ext", resolvedPath: null }]);
			expect(lossReports()).toHaveLength(1);
			expect(lossReports()[0]?.message).toBe(
				"A plugin directory could not be read; the entries inside it are not being loaded",
			);
			expect(lossReports()[0]?.meta.dir).toBe(dir);
			expect(String(lossReports()[0]?.meta.error)).not.toBe("");
		}

		fs.chmodSync(dir, 0o755);
	});

	/**
	 * What CANNOT reach the report, pinned so the guard is not mistaken for dead code.
	 *
	 * An ENOTDIR test was written here first and it never got to the readdir: the resolver stats the
	 * declared path before expanding it, so a path that is a file is returned as the entry itself. That
	 * also means an ABSENT path is answered by the stat, not by the readdir, and the only failures that
	 * reach the report are ones where the directory existed a moment ago and then could not be read --
	 * permissions, an I/O error, or the directory being removed in between. The ENOENT branch in the fix
	 * is for that last race, which is why it is keyed on the error rather than removed.
	 */
	it("returns a declared file as the entry itself, never reaching the directory expansion", () => {
		const file = path.join(root, "ext.md");
		fs.writeFileSync(file, "# not a directory");

		expect(resolveExtensions("ext.md")).toEqual([{ entry: "ext.md", resolvedPath: file }]);
		expect(lossReports()).toEqual([]);
	});
});
