/**
 * injectPluginDirRoots reads each --plugin-dir target's
 * `.claude-plugin/plugin.json` to name the synthetic plugin root, falling back
 * to the directory basename when the manifest is absent. A --plugin-dir path is
 * something the user asked for explicitly, so a manifest that EXISTS but cannot
 * be parsed must not be swallowed into a silent basename fallback (Law 10): a
 * missing manifest is expected and stays silent, a malformed one warns.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { clearPluginRootsAndCaches, getPreloadedPluginRoots, injectPluginDirRoots } from "../../src/discovery/helpers";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function inject(dir: string): Promise<void> {
	// cwd points at an empty tempdir so no ambient project registry contributes roots.
	const cwd = makeTempDir("veyyon-plugin-dir-cwd-");
	await injectPluginDirRoots(cwd, [dir], cwd);
}

function injectedRootFor(dir: string): { plugin: string } | undefined {
	const resolved = path.resolve(dir);
	return getPreloadedPluginRoots().find(root => root.path === resolved);
}

afterEach(() => {
	clearPluginRootsAndCaches();
	vi.restoreAllMocks();
});

describe("injectPluginDirRoots manifest name (Law 10)", () => {
	it("uses the manifest name when plugin.json is well-formed, without warning", async () => {
		const dir = makeTempDir("veyyon-plugin-dir-ok-");
		fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme-tools" }));
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await inject(dir);

		expect(injectedRootFor(dir)?.plugin).toBe("acme-tools");
		const manifestWarned = warnSpy.mock.calls.some(([message]) =>
			String(message).includes("Plugin manifest exists but could not be read"),
		);
		expect(manifestWarned).toBe(false);
	});

	it("falls back to the directory basename silently when no manifest exists", async () => {
		const dir = makeTempDir("veyyon-plugin-dir-none-");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await inject(dir);

		expect(injectedRootFor(dir)?.plugin).toBe(path.basename(dir));
		const manifestWarned = warnSpy.mock.calls.some(([message]) =>
			String(message).includes("Plugin manifest exists but could not be read"),
		);
		expect(manifestWarned).toBe(false);
	});

	it("warns and falls back to the basename when the manifest is malformed", async () => {
		const dir = makeTempDir("veyyon-plugin-dir-bad-");
		fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
		const manifestPath = path.join(dir, ".claude-plugin", "plugin.json");
		fs.writeFileSync(manifestPath, '{ "name": broken ');
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await inject(dir);

		expect(injectedRootFor(dir)?.plugin).toBe(path.basename(dir));
		const warned = warnSpy.mock.calls.some(([message, context]) => {
			const ctx = context as Record<string, unknown> | undefined;
			return (
				String(message).includes("Plugin manifest exists but could not be read") &&
				typeof ctx?.path === "string" &&
				ctx.path === manifestPath
			);
		});
		expect(warned).toBe(true);
	});
});
