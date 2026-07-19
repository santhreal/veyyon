/**
 * loadFilesFromDir globs a discovery directory (skills, rules, extensions). An
 * empty scan is ambiguous: a genuinely empty or missing directory is the normal
 * "nothing to discover" case, but a directory that EXISTS yet denies read
 * access means its files silently vanished (Law 10). The native glob cannot
 * carry that distinction across the boundary, so loadFilesFromDir re-classifies
 * an empty scan with Node fs (a real errno, not a message match): an unreadable
 * directory surfaces a warning while a missing or empty one stays silent.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import type { LoadContext } from "../../src/capability/types";
import { loadFilesFromDir } from "../../src/discovery/helpers";

const ctx: LoadContext = { cwd: "/", home: "/", repoRoot: null };

// Root bypasses permission checks, so a chmod-000 directory is still readable
// under uid 0 and the unreadable-directory assertions cannot hold there.
const isUnix = process.platform !== "win32";
const isRoot = isUnix && typeof process.getuid === "function" && process.getuid() === 0;
const canTestUnreadable = isUnix && !isRoot;

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-unreadable-dir-"));
}

const created: string[] = [];
function trackedTempDir(): string {
	const dir = makeTempDir();
	created.push(dir);
	return dir;
}

async function collectText(dir: string) {
	return loadFilesFromDir<string>(ctx, dir, "test-provider", "user", {
		extensions: ["md"],
		transform: (_name, content) => content,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of created.splice(0)) {
		// Restore permissions so a chmod-000 case can be removed, then delete.
		try {
			fs.chmodSync(dir, 0o755);
		} catch {
			// Already removable or already gone.
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadFilesFromDir unreadable-directory surfacing (Law 10)", () => {
	it.skipIf(!canTestUnreadable)(
		"warns and records a warning when the directory exists but is not readable",
		async () => {
			const dir = trackedTempDir();
			fs.writeFileSync(path.join(dir, "note.md"), "hidden content");
			fs.chmodSync(dir, 0o000);
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await collectText(dir);

			expect(result.items).toEqual([]);
			expect(result.warnings?.some(w => w.includes("not readable") && w.includes(dir))).toBe(true);
			const logged = warnSpy.mock.calls.some(
				([message]) => message === "Discovery: directory exists but is not readable; its entries were skipped",
			);
			expect(logged).toBe(true);
		},
	);

	it("does not warn for a readable directory that yields files", async () => {
		const dir = trackedTempDir();
		fs.writeFileSync(path.join(dir, "note.md"), "visible content");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = await collectText(dir);

		expect(result.items).toEqual(["visible content"]);
		expect(result.warnings ?? []).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("does not warn for a readable but empty directory", async () => {
		const dir = trackedTempDir();
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = await collectText(dir);

		expect(result.items).toEqual([]);
		expect(result.warnings ?? []).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("does not warn for a missing directory", async () => {
		const dir = path.join(os.tmpdir(), "veyyon-unreadable-dir-missing-does-not-exist-xyz");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const result = await collectText(dir);

		expect(result.items).toEqual([]);
		expect(result.warnings ?? []).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
