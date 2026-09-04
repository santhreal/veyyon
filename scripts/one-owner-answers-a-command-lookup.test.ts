/**
 * Direct calls to `Bun.which` bypass Darwin toolchain fallbacks and caching in `$which`.
 * This sweeps tracked TypeScript sources to ensure all command lookups go through `@veyyon/utils/which`.
 * It inspects source text for raw `Bun.which(` calls and does not analyze dynamic property lookups.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { existingOnly } from "./check-doc-links";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const OWNER_FILE = "packages/utils/src/which.ts";

/**
 * Pinned allowlist of files permitted to reference `Bun.which(`.
 * Shrink-only: removing an entry when migrating a file is expected; adding one requires a reason.
 */
export const ALLOWLIST: Readonly<Record<string, string>> = {
	"packages/coding-agent/test/shell-snapshot.test.ts": "test helper locating system echo binary",
	"packages/coding-agent/test/source-launcher.test.ts": "test helper locating runner bun binary",
	"natives/bridge/bindings/scripts/build-native.ts": "bootstraps native addon before @veyyon/utils is available",
	"natives/bridge/bindings/scripts/ensure-native.ts": "bootstraps native addon before @veyyon/utils is available",
	"natives/bridge/bindings/scripts/native-portability.ts": "bootstraps native addon before @veyyon/utils is available",
	"natives/bridge/bindings/test/native.test.ts": "native addon test suite running without @veyyon/utils dependency",
	"python/veybot/web/scripts/verify-cards.ts": "standalone python extension verification script",
	"python/veybot/web/scripts/verify-live.ts": "standalone python extension verification script",
	"scripts/one-owner-answers-a-command-lookup.test.ts": "quotes the owner call to assert the owner implements it",
	"scripts/tests-never-touch-real-home.test.ts": "quotes Bun.which in static test fixture string",
};

function trackedTsFiles(): string[] {
	const stdout = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return existingOnly(
		REPO_ROOT,
		stdout
			.split("\n")
			.map(s => s.trim())
			.filter(file => file.length > 0),
	);
}

describe("one owner answers a command lookup", () => {
	it("has the owner file implementing Bun.which", () => {
		const ownerContent = fs.readFileSync(path.join(REPO_ROOT, OWNER_FILE), "utf8");
		expect(ownerContent).toContain("Bun.which(");
	});

	it("restricts Bun.which( calls to the single owner and pinned allowlist", () => {
		const files = trackedTsFiles();
		expect(files.length).toBeGreaterThan(1000);

		const observedViolations: Record<string, string[]> = {};

		for (const file of files) {
			if (file === OWNER_FILE) continue;
			const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			if (!content.includes("Bun.which(")) continue;

			const lines = content.split("\n");
			const matchedLines: string[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes("Bun.which(")) {
					matchedLines.push(`${file}:${i + 1}: ${lines[i].trim()}`);
				}
			}
			observedViolations[file] = matchedLines;
		}

		const observedFiles = Object.keys(observedViolations).sort();
		const allowedFiles = Object.keys(ALLOWLIST).sort();

		expect(observedFiles).toEqual(allowedFiles);
	});
});
