// A version heading may appear at most once in a package changelog.
//
// Why: `packages/coding-agent/CHANGELOG.md` shipped with the
// entire `## [1.0.38] - 2026-07-31` section in it twice.
//

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { versionHeadings } from "./changelog-unreleased";
import { typeScriptMembers } from "./workspace-layout";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** A version heading and every line it was found on, in file order. */
type Duplicate = { version: string; lines: number[] };

/**
 * Every released-version heading that appears more than once in one changelog.
 *
 * Matches `## [X.Y.Z]` only. `## [Unreleased]` is deliberately excluded (it is a
 * placeholder, not a release) and so is a plain `## Upstream history`, which is a real
 * heading in the coding-agent changelog and is not a version at all.
 */
export function duplicateVersionHeadings(markdown: string): Duplicate[] {
	const seen = new Map<string, number[]>();
	versionHeadings(markdown).forEach(({ version, line }) => {
		const lines = seen.get(version);
		if (lines) lines.push(line);
		else seen.set(version, [line]);
	});
	return [...seen].filter(([, lines]) => lines.length > 1).map(([version, lines]) => ({ version, lines }));
}

/**
 * Every member changelog (`CHANGELOG.md` directly under a workspace member), repo-relative.
 *
 * The members are read from the root manifest. Scanning `packages/` alone left `contracts/wire` and
 * `contracts/view` outside the rule, so either could ship a duplicated release section — the exact
 * incident this gate exists for — with the gate green. The root view was in turn blind to literal
 * paths (`natives/bridge/bindings`, `python/veybot/web`), which `typeScriptMembers()` now reaches.
 */
function packageChangelogs(): string[] {
	const found: string[] = [];
	for (const member of typeScriptMembers()) {
		const rel = `${member}/CHANGELOG.md`;
		if (existsSync(path.join(REPO_ROOT, rel))) {
			found.push(rel);
		}
	}
	return found.sort();
}

describe("duplicateVersionHeadings", () => {
	it("reports the repeated version and both of its line numbers", () => {
		// The shape of the real incident: one section, emitted twice, with the second
		// copy carrying content the first does not.
		const fixture = [
			"# Changelog",
			"",
			"## [1.0.39] - 2026-08-01",
			"",
			"- something newer",
			"",
			"## [1.0.38] - 2026-07-31",
			"",
			"### Fixed",
			"",
			"- the nine bullets that existed in only one copy",
			"",
			"## [1.0.38] - 2026-07-31",
			"",
			"### Changed",
			"",
			"- the hundred and fourteen bullets that existed in only the other",
			"",
			"## [1.0.37] - 2026-07-24",
			"",
			"- older",
		].join("\n");

		expect(duplicateVersionHeadings(fixture)).toEqual([{ version: "1.0.38", lines: [7, 13] }]);
	});

	it("catches a third copy and reports every line, not just the first pair", () => {
		const fixture = ["## [2.1.0] - 2026-01-01", "## [2.1.0] - 2026-01-01", "## [2.1.0] - 2026-01-01"].join("\n");
		expect(duplicateVersionHeadings(fixture)).toEqual([{ version: "2.1.0", lines: [1, 2, 3] }]);
	});

	it("passes a changelog whose versions are all distinct", () => {
		const fixture = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [1.0.2] - 2026-01-03",
			"",
			"## [1.0.1] - 2026-01-02",
			"",
			"## [1.0.0] - 2026-01-01",
		].join("\n");
		expect(duplicateVersionHeadings(fixture)).toEqual([]);
	});

	it("does not mistake a repeated non-version heading for a duplicate release", () => {
		// `## [Unreleased]` and `## Upstream history` are not releases. A checker that
		// counted every `## ` heading would fire on the coding-agent changelog forever
		// and get switched off, which is worse than not having it.
		const fixture = [
			"## [Unreleased]",
			"",
			"## [1.0.1] - 2026-01-02",
			"",
			"## Upstream history",
			"",
			"## [Unreleased]",
			"",
			"## Upstream history",
		].join("\n");
		expect(duplicateVersionHeadings(fixture)).toEqual([]);
	});

	it("does not treat the same version in two DIFFERENT files as a duplicate", () => {
		// Packages are versioned in lockstep, so 1.0.38 legitimately appears in most of
		// them. The check is per-file and must stay that way.
		const one = "## [1.0.38] - 2026-07-31\n\n- a change in one package";
		const two = "## [1.0.38] - 2026-07-31\n\n- a change in another";
		expect(duplicateVersionHeadings(one)).toEqual([]);
		expect(duplicateVersionHeadings(two)).toEqual([]);
	});
});

describe("every member CHANGELOG.md", () => {
	const changelogs = packageChangelogs();

	it("finds the member changelogs to check, under every root", () => {
		// A glob that silently matched nothing would make every check below vacuous, and a glob that
		// matched one root only would make it vacuous for the members under the others.
		expect(changelogs).toContain("packages/coding-agent/CHANGELOG.md");
		expect(changelogs).toContain("contracts/wire/CHANGELOG.md");
		expect(changelogs.length).toBeGreaterThanOrEqual(15);
	});

	it("has no version heading more than once", () => {
		const offenders = changelogs.flatMap(file => {
			const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
			return duplicateVersionHeadings(markdown).map(
				dup => `${file}: ## [${dup.version}] appears ${dup.lines.length} times, on lines ${dup.lines.join(", ")}`,
			);
		});
		expect(offenders).toEqual([]);
	});

	it("has exactly one ## [1.0.38] heading in the coding-agent changelog", () => {
		// The specific section this incident duplicated, pinned by count so a
		// reintroduction fails here by name rather than in a generic sweep.
		const markdown = readFileSync(path.join(REPO_ROOT, "packages/coding-agent/CHANGELOG.md"), "utf8");
		const headings = markdown.split("\n").filter(line => line.startsWith("## [1.0.38]"));
		expect(headings).toEqual(["## [1.0.38] - 2026-07-31"]);
	});
});
