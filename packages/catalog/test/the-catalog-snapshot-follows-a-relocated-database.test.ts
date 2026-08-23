/**
 * The enriched-catalog snapshot must live beside the database of the registry
 * that reads it. A relocated registry (SDK hosts, tests) once wrote its
 * snapshot beside the DEFAULT profile's `models.db`, where nothing read it
 * back — a per-launch write with no cross-launch benefit, plus cross-profile
 * contamination. This pins the relocation seam:
 * `setBundledRegistryCacheDbPath` decides where an explicitly-pathless
 * snapshot write lands.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules`
// link resolves to the primary checkout rather than to this worktree, so the
// package specifier would test someone else's source.
import { setBundledRegistryCacheDbPath, writeEnrichedRegistrySnapshot } from "../src/models";

describe("bundled registry cache path relocation", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		setBundledRegistryCacheDbPath(undefined);
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		tempDir = undefined;
	});

	it("a pathless snapshot write follows the pinned database location", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reloc-"));
		setBundledRegistryCacheDbPath(path.join(tempDir, "models.db"));

		writeEnrichedRegistrySnapshot(new Map(), "v1:test");

		expect(fs.existsSync(path.join(tempDir, "bundled-models.json"))).toBe(true);
	});
});
