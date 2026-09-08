import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildRollbackRows } from "../../src/cli/rollback-cli";
import {
	isAutoUpdateDisabled,
	isCurrentProcessLocalOrCustom,
	readVersionMoves,
	replaceBinaryForUpdate,
	runAutoUpdate,
} from "../../src/cli/update-cli";
import type { SettingPath } from "../../src/config/settings-schema";

describe("auto-update guard and opt-out controls", () => {
	let tempDir = "";
	const release = { tag: "v9.9.9", version: "9.9.9" };
	const binaryInstall = () => "binary" as const;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-auto-update-guard-"));
		delete process.env.VEYYON_NO_AUTO_UPDATE;
		delete process.env.VEYYON_AUTO_UPDATE;
		delete process.env.VEYYON_BUILD_TAG;
		delete process.env.VEYYON_BUILD_LOCAL;
	});

	afterEach(async () => {
		delete process.env.VEYYON_NO_AUTO_UPDATE;
		delete process.env.VEYYON_AUTO_UPDATE;
		delete process.env.VEYYON_BUILD_TAG;
		delete process.env.VEYYON_BUILD_LOCAL;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	describe("isAutoUpdateDisabled", () => {
		it("returns true when VEYYON_NO_AUTO_UPDATE is set to truthy value", () => {
			for (const val of ["1", "true", "yes", "on", " TRUE "]) {
				process.env.VEYYON_NO_AUTO_UPDATE = val;
				expect(isAutoUpdateDisabled()).toBe(true);
			}
		});

		it("returns true when VEYYON_AUTO_UPDATE is set to falsy value", () => {
			for (const val of ["0", "false", "no", "off", " FALSE "]) {
				process.env.VEYYON_AUTO_UPDATE = val;
				expect(isAutoUpdateDisabled()).toBe(true);
			}
		});

		it("returns true when startup.autoUpdate is false in settings", () => {
			const mockSettings = {
				get: (p: SettingPath) => p !== "startup.autoUpdate",
			};
			expect(isAutoUpdateDisabled(mockSettings)).toBe(true);
		});

		it("returns true when updates.auto is false in settings", () => {
			const mockSettings = {
				get: (p: SettingPath) => p !== "updates.auto",
			};
			expect(isAutoUpdateDisabled(mockSettings)).toBe(true);
		});

		it("returns false when enabled by default", () => {
			const mockSettings = {
				get: () => true,
			};
			expect(isAutoUpdateDisabled(mockSettings)).toBe(false);
		});
	});

	describe("isCurrentProcessLocalOrCustom", () => {
		it("detects local/custom build via VEYYON_BUILD_LOCAL", () => {
			process.env.VEYYON_BUILD_LOCAL = "true";
			expect(isCurrentProcessLocalOrCustom()).toBe(true);
		});

		it("detects local/custom build via VEYYON_BUILD_TAG", () => {
			process.env.VEYYON_BUILD_TAG = "a19ab2a13-local";
			expect(isCurrentProcessLocalOrCustom()).toBe(true);
		});
	});

	describe("replaceBinaryForUpdate custom build guard", () => {
		const okVerifier = () => Promise.resolve({ ok: true as const, actual: "9.9.9" });

		it("refuses to replace custom build when force is false", async () => {
			const target = path.join(tempDir, "veyyon");
			const temp = path.join(tempDir, "veyyon.new");
			const backup = path.join(tempDir, "veyyon.bak");

			// Set env so isCurrentProcessLocalOrCustom() detects custom build
			process.env.VEYYON_BUILD_LOCAL = "true";
			writeFileSync(target, "#!/bin/sh\necho '1.4.1 (a19ab2a13-local)'\n", { mode: 0o755 });
			writeFileSync(temp, "NEW-BINARY-PAYLOAD");

			await expect(
				replaceBinaryForUpdate({
					targetPath: target,
					tempPath: temp,
					backupPath: backup,
					expectedVersion: "9.9.9",
					verifyInstalledVersion: okVerifier,
					force: false,
				}),
			).rejects.toThrow(/Refusing to replace.*custom or local build/);

			// Ensure target binary was NOT replaced
			const content = await fs.readFile(target, "utf8");
			expect(content).toContain("1.4.1 (a19ab2a13-local)");
		});

		it("allows replacement when force is true", async () => {
			const target = path.join(tempDir, "veyyon");
			const temp = path.join(tempDir, "veyyon.new");
			const backup = path.join(tempDir, "veyyon.bak");

			writeFileSync(target, "CUSTOM-BINARY");
			writeFileSync(temp, "NEW-BINARY-PAYLOAD");

			process.env.VEYYON_BUILD_LOCAL = "true";

			// Replacement with force: true succeeds
			const result = await replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: okVerifier,
				force: true,
			});

			expect(result.ok).toBe(true);
			const content = await fs.readFile(target, "utf8");
			expect(content).toBe("NEW-BINARY-PAYLOAD");
		});
	});

	describe("runAutoUpdate guard and history recording", () => {
		it("skips and records history when automatic updates are disabled", async () => {
			const statePath = path.join(tempDir, "auto-update.json");
			const historyPath = path.join(tempDir, "update-history.json");
			let installCalled = false;

			process.env.VEYYON_NO_AUTO_UPDATE = "1";

			const outcome = await runAutoUpdate(
				"1.0.0",
				release,
				statePath,
				binaryInstall,
				async () => {
					installCalled = true;
					return { warnings: [] };
				},
				historyPath,
			);

			expect(outcome.status).toBe("skipped");
			if (outcome.status === "skipped") {
				expect(outcome.reason).toBe("disabled");
				expect(outcome.version).toBe("9.9.9");
			}
			expect(installCalled).toBe(false);

			// Verify history entry
			const history = await readVersionMoves(historyPath);
			expect(history.length).toBe(1);
			expect(history[0]).toMatchObject({
				from: "1.0.0",
				to: "9.9.9",
				status: "skipped",
				reason: "disabled",
			});
		});

		it("skips and records history when target is a custom/local build", async () => {
			const statePath = path.join(tempDir, "auto-update.json");
			const historyPath = path.join(tempDir, "update-history.json");
			let installCalled = false;

			const outcome = await runAutoUpdate(
				"1.0.0",
				release,
				statePath,
				binaryInstall,
				async () => {
					installCalled = true;
					return { warnings: [] };
				},
				historyPath,
				undefined,
				// isCustomBuildOverride:
				() => true,
			);

			expect(outcome.status).toBe("skipped");
			if (outcome.status === "skipped") {
				expect(outcome.reason).toBe("custom-build");
				expect(outcome.version).toBe("9.9.9");
			}
			expect(installCalled).toBe(false);

			const history = await readVersionMoves(historyPath);
			expect(history.length).toBe(1);
			expect(history[0]).toMatchObject({
				from: "1.0.0",
				to: "9.9.9",
				status: "skipped",
				reason: "custom-build",
			});
		});

		it("skips and records history when method is source install", async () => {
			const statePath = path.join(tempDir, "auto-update.json");
			const historyPath = path.join(tempDir, "update-history.json");
			let installCalled = false;

			const outcome = await runAutoUpdate(
				"1.0.0",
				release,
				statePath,
				() => "source",
				async () => {
					installCalled = true;
					return { warnings: [] };
				},
				historyPath,
			);

			expect(outcome.status).toBe("skipped");
			if (outcome.status === "skipped") {
				expect(outcome.reason).toBe("source-install");
			}
			expect(installCalled).toBe(false);

			const history = await readVersionMoves(historyPath);
			expect(history.length).toBe(1);
			expect(history[0]).toMatchObject({
				from: "1.0.0",
				to: "9.9.9",
				status: "skipped",
				reason: "source-install",
			});
		});
	});

	describe("rollback history ignores skipped move.to", () => {
		it("does not mark skipped version as visited", () => {
			const releases = [
				{ tag: "v1.0.0", version: "1.0.0", publishedAt: "2026-01-01T00:00:00Z" },
				{ tag: "v1.4.1", version: "1.4.1", publishedAt: "2026-02-01T00:00:00Z" },
			];
			const moves = [
				{
					from: "1.0.0",
					to: "1.4.1",
					at: "2026-02-02T00:00:00Z",
					status: "skipped" as const,
					reason: "custom-build",
				},
			];

			const rows = buildRollbackRows(releases, "1.0.0", moves);
			const row141 = rows.find(r => r.version === "1.4.1");
			expect(row141?.visited).toBe(false);

			const row100 = rows.find(r => r.version === "1.0.0");
			expect(row100?.visited).toBe(true);
		});
	});
});
