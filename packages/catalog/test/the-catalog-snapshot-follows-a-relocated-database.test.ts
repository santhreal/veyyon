/**
 * The enriched-catalog snapshot must live beside the database of the registry
 * that reads it. A relocated registry (SDK hosts, tests) once wrote its
 * snapshot beside the DEFAULT profile's `models.db`, where nothing read it
 * back — a per-launch write with no cross-launch benefit, plus cross-profile
 * contamination. This pins the relocation seam: a store built for one database
 * reads and writes beside that database and no other.
 *
 * WHAT THIS DOES NOT CATCH: whether the coding-agent registry passes the right
 * database path when it builds the store. `the-static-model-stage-snapshot-...`
 * covers that end of the seam.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules`
// link resolves to the primary checkout rather than to this worktree, so the
// package specifier would test someone else's source.
import { createEnrichedRegistrySnapshotStore } from "../src/registry-snapshot";

describe("bundled registry cache path relocation", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		tempDir = undefined;
	});

	it("writes and reads beside the database it was built for", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reloc-"));
		const relocated = path.join(tempDir, "profile-a");
		const other = path.join(tempDir, "profile-b");
		fs.mkdirSync(relocated);
		fs.mkdirSync(other);
		const store = createEnrichedRegistrySnapshotStore(path.join(relocated, "models.db"));

		store.write(new Map(), "v2:test");

		expect(fs.existsSync(path.join(relocated, "bundled-models.json"))).toBe(true);
		expect(fs.existsSync(path.join(other, "bundled-models.json"))).toBe(false);
		expect(store.read("v2:test")).not.toBeNull();
		// A store pinned elsewhere must not serve the relocated snapshot.
		expect(createEnrichedRegistrySnapshotStore(path.join(other, "models.db")).read("v2:test")).toBeNull();
	});
});
