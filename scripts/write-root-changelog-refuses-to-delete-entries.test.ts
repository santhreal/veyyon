/**
 * The root changelog writer must not delete unreleased entries no package claims.
 *
 * This guard existed, but it lived inside `sync-root-changelog.ts`'s `main()`, so
 * it protected the CLI and nothing else. `release.ts` wrote the same file one
 * line after the changelog roll with a bare
 * `Bun.write(ROOT_PATH, buildRootChangelog())` and never consulted it, which is
 * the worst place to lose the check: by the time anyone notices an entry is
 * missing, the tag, the npm packages and the GitHub release have all shipped
 * under a changelog that never mentioned it.
 *
 * The check now owns the write, so both callers go through it. These tests drive
 * the writer against a REAL file in a temp directory and assert the bytes on
 * disk, because the contract is that the entry survives, not that a function
 * returned a flag saying it would.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRootChangelog, writeRootChangelog } from "./sync-root-changelog";

/** A root file holding the real render plus one entry no package claims. */
function rootWithAnOrphan(orphan: string): { path: string; before: string } {
	const dir = mkdtempSync(join(tmpdir(), "veyyon-root-changelog-"));
	const path = join(dir, "CHANGELOG.md");
	const rendered = buildRootChangelog();
	const heading = /^## \[Unreleased\][^\n]*$/m.exec(rendered);
	if (!heading) throw new Error("the real render has no Unreleased heading, so this fixture cannot be built");
	const at = heading.index + heading[0].length;
	const before = `${rendered.slice(0, at)}\n\n- ${orphan}${rendered.slice(at)}`;
	writeFileSync(path, before);
	return { path, before };
}

const ORPHAN = "Somebody typed this straight into the generated root file and no package changelog claims it.";

describe("writeRootChangelog", () => {
	it("leaves the file untouched when writing it would delete an unclaimed entry", () => {
		const { path, before } = rootWithAnOrphan(ORPHAN);

		const result = writeRootChangelog({ rootPath: path });

		expect(result.wrote).toBe(false);
		expect(result.orphans).toEqual([ORPHAN]);
		// The contract is the bytes, not the flag.
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readFileSync(path, "utf8")).toContain(ORPHAN);
	});

	it("discards the entry only when force says to, which is what --force buys", () => {
		const { path } = rootWithAnOrphan(ORPHAN);

		const result = writeRootChangelog({ rootPath: path, force: true });

		expect(result.wrote).toBe(true);
		expect(readFileSync(path, "utf8")).not.toContain(ORPHAN);
		expect(readFileSync(path, "utf8")).toBe(buildRootChangelog());
	});

	it("writes when nothing is at risk, so the guard does not block ordinary regeneration", () => {
		const dir = mkdtempSync(join(tmpdir(), "veyyon-root-changelog-"));
		const path = join(dir, "CHANGELOG.md");
		writeFileSync(path, "# Changelog\n\n## [Unreleased]\n");

		const result = writeRootChangelog({ rootPath: path });

		expect(result.wrote).toBe(true);
		expect(result.orphans).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(buildRootChangelog());
	});

	it("writes when the root does not exist yet, which is a first render and not a deletion", () => {
		const dir = mkdtempSync(join(tmpdir(), "veyyon-root-changelog-"));
		const path = join(dir, "CHANGELOG.md");

		const result = writeRootChangelog({ rootPath: path });

		expect(result.wrote).toBe(true);
		expect(result.current).toBeNull();
		expect(readFileSync(path, "utf8")).toBe(buildRootChangelog());
	});
});
