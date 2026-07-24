#!/usr/bin/env bun

/**
 * Generate aggregated release notes from per-package CHANGELOG.md files.
 *
 * Walks the version range `(latest-published-release, target]` so changelog
 * sections finalized under intervening *silent* tags (a `vX.Y.Z` tag that
 * exists on the remote but has no GitHub Release — most often because a CI
 * concurrency-cancel killed the publish job, #2596 / #2564) are rolled into
 * the next published release body. Sections are grouped by `package.json`
 * `name`, then merged per `### <category>` bullet bucket. Bullet lines are
 * deduplicated by exact trimmed text so post-release changelog flattening
 * (`fix-changelogs`) does not surface the same entry twice. Sections without
 * entries are skipped.
 *
 * Usage:
 *   bun scripts/ci-release-notes.ts                     # writes release-notes.md
 *   bun scripts/ci-release-notes.ts v15.4.3             # explicit tag/version
 *   bun scripts/ci-release-notes.ts 15.4.3 notes.md     # custom output path
 *
 * The lower bound is resolved by `gh release list`. Set
 * `VEYYON_RELEASE_NOTES_FLOOR=v15.12.4` to override (empty string forces
 * single-version mode, matching the pre-#2596 behavior). `VEYYON_REPO`
 * / `GITHUB_REPOSITORY` control the queried repo.
 *
 * Intended for the `release_github` CI job: the output is passed to
 * `softprops/action-gh-release` via `body_path:`. The action's
 * `generate_release_notes: true` still appends the auto-generated PR list
 * underneath; this only adds curated context.
 */

import { $, Glob } from "bun";
// Import compareSemver by RELATIVE PATH, not the "@veyyon/utils/semver"
// workspace specifier. The release_github job that runs this script checks out
// the repo and sets up bun but does NOT `bun install`, so the workspace symlink
// `node_modules/@veyyon/utils` does not exist and the package specifier fails to
// resolve ("Cannot find module '@veyyon/utils/semver'"). That crashed the very
// first release_github run to completion (v1.0.20) and blocked the publish.
// semver.ts is self-contained (no imports of its own), so a direct file import
// needs no install and cannot regress this way.
import { compareSemver } from "../packages/utils/src/semver.ts";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const REPO = process.env.VEYYON_REPO ?? process.env.GITHUB_REPOSITORY ?? "santhreal/veyyon";

// Canonical ordering used by `fix-changelogs`; unknown categories sort
// alphabetically after these.
const CATEGORY_ORDER = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;

/**
 * Compare two version strings, accepting a leading `v` on either side.
 *
 * Delegates to the repo-wide comparator rather than matching `X.Y.Z` here. The
 * local version this replaced returned 0 for anything that did not match that
 * exact shape, which read as "these are the same version". A prerelease target
 * such as `1.2.1-rc.1` therefore compared equal to every entry in the
 * changelog, and the release notes for it merged the project's entire history.
 */
export function compareVersions(a: string, b: string): number {
	return compareSemver(a.trim(), b.trim());
}

export interface ChangelogVersionSpan {
	version: string;
	/** 0-indexed line of the `## [X.Y.Z]` heading. */
	start: number;
	/** 0-indexed line just past the last line of this version's body (exclusive). */
	end: number;
}

/**
 * Locate every `## [X.Y.Z]` heading in a changelog and compute the line span
 * up to (but not including) the next `## [` heading. `## [Unreleased]` and
 * other non-semver `## [...]` headings are ignored, but they still act as
 * span boundaries for the preceding version.
 */
export function enumerateChangelogVersions(content: string): ChangelogVersionSpan[] {
	const lines = content.split("\n");
	const spans: ChangelogVersionSpan[] = [];
	// Indexes of *any* `## [` heading (including Unreleased) so a version's
	// span ends at the next heading of any kind.
	const headingIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## [")) headingIdx.push(i);
	}
	for (const idx of headingIdx) {
		const m = lines[idx].match(/^## \[(\d+\.\d+\.\d+)\]/);
		if (!m) continue;
		const nextIdx = headingIdx.find(j => j > idx) ?? lines.length;
		spans.push({ version: m[1], start: idx, end: nextIdx });
	}
	return spans;
}

/**
 * Merge `(floorExclusive, targetInclusive]` version sections from a single
 * package's changelog into one combined body, grouped by `### <category>`.
 *
 * Versions iterate newest → oldest so newer phrasing wins when a bullet was
 * flattened forward by `fix-changelogs` and ends up in both sections.
 * `floorExclusive === null` → take only the target version (legacy behavior).
 * Returns "" when no in-range version contributes any bullet.
 */
export function mergePackageSection(content: string, floorExclusive: string | null, targetInclusive: string): string {
	const spans = enumerateChangelogVersions(content)
		.filter(v => {
			if (compareVersions(v.version, targetInclusive) > 0) return false;
			if (floorExclusive === null) return compareVersions(v.version, targetInclusive) === 0;
			return compareVersions(v.version, floorExclusive) > 0;
		})
		.sort((a, b) => compareVersions(b.version, a.version));
	if (spans.length === 0) return "";

	const lines = content.split("\n");
	const seenCategories: string[] = []; // first-seen order
	const buckets = new Map<string, string[]>();
	const seenLines = new Set<string>();

	for (const span of spans) {
		let currentCat: string | null = null;
		let buf: string[] = [];
		const flushCurrent = () => {
			if (currentCat === null || buf.length === 0) return;
			let bucket = buckets.get(currentCat);
			if (!bucket) {
				bucket = [];
				buckets.set(currentCat, bucket);
				seenCategories.push(currentCat);
			}
			for (const line of buf) {
				const key = line.trim();
				if (key.length === 0) continue;
				if (seenLines.has(key)) continue;
				seenLines.add(key);
				bucket.push(line);
			}
		};
		// Skip the `## [X.Y.Z]` heading line itself.
		for (let i = span.start + 1; i < span.end; i++) {
			const line = lines[i];
			const catMatch = line.match(/^### (.+?)\s*$/);
			if (catMatch) {
				flushCurrent();
				currentCat = catMatch[1];
				buf = [];
				continue;
			}
			// Pre-category prose (rare; usually blank padding) is dropped — there
			// is no surrounding `###` to attribute it to in the merged output.
			if (currentCat === null) continue;
			buf.push(line);
		}
		flushCurrent();
	}

	if (seenCategories.length === 0) return "";

	seenCategories.sort((a, b) => {
		const ai = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number]);
		const bi = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number]);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});

	const out: string[] = [];
	for (const cat of seenCategories) {
		const bucket = buckets.get(cat) ?? [];
		// Collapse runs of blank lines and strip trailing blanks per bucket.
		const collapsed: string[] = [];
		let prevBlank = false;
		for (const line of bucket) {
			const blank = line.trim().length === 0;
			if (blank && prevBlank) continue;
			collapsed.push(line);
			prevBlank = blank;
		}
		while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim().length === 0) {
			collapsed.pop();
		}
		if (collapsed.length === 0) continue;
		out.push(`### ${cat}`, "", ...collapsed, "");
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Commit-history summary
// ═══════════════════════════════════════════════════════════════════════════
//
// The curated per-package CHANGELOG sections above are high-signal but sparse:
// only bullets a PR author hand-wrote appear, and this repo pushes straight to
// main, so `action-gh-release`'s PR-based `generate_release_notes` list is also
// near-empty. The result was releases whose whole body was one bullet even when
// dozens of real commits landed ("400 commits says nothing"). This section
// closes that gap: it groups every non-merge commit in the release range by its
// conventional-commit type so each release reflects its actual work with no
// manual curation. It is derived, additive context — never a replacement for the
// curated sections, which stay first.

/** Conventional-commit type prefix → release-notes heading. First match wins. */
const COMMIT_TYPE_HEADINGS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^feat$/, "Features"],
	[/^fix$/, "Fixes"],
	[/^perf$/, "Performance"],
	[/^refactor$/, "Refactors"],
	[/^revert$/, "Reverts"],
	[/^docs$/, "Documentation"],
	[/^test$/, "Tests"],
	[/^(build|ci)$/, "Build & CI"],
	[/^(chore|style)$/, "Chores"],
];
const BREAKING_HEADING = "Breaking Changes";
const OTHER_HEADING = "Other changes";
// Display order for the grouped sections. Breaking changes lead; unmatched
// commits ("Other changes") trail. Everything else follows the type table.
const HEADING_ORDER: readonly string[] = [
	BREAKING_HEADING,
	...COMMIT_TYPE_HEADINGS.map(([, heading]) => heading),
	OTHER_HEADING,
];

function headingForCommitType(type: string): string | null {
	for (const [pattern, heading] of COMMIT_TYPE_HEADINGS) {
		if (pattern.test(type)) return heading;
	}
	return null;
}

export interface GroupedCommitSection {
	heading: string;
	subjects: string[];
}

/**
 * Bucket commit subject lines by conventional-commit type, preserving the full
 * `type(scope): description` subject for display and deduplicating identical
 * subjects (a cherry-pick or a forward-merge can repeat one). A subject with a
 * `!` breaking marker (`feat!:` / `fix(x)!:`) goes to {@link BREAKING_HEADING}
 * regardless of its base type; a subject with no recognizable conventional
 * prefix goes to {@link OTHER_HEADING} so nothing is dropped. Sections come back
 * in {@link HEADING_ORDER}; empty buckets are omitted.
 */
export function groupCommitsByType(subjects: readonly string[]): GroupedCommitSection[] {
	const buckets = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const raw of subjects) {
		const subject = raw.trim();
		if (subject.length === 0) continue;
		if (seen.has(subject)) continue;
		seen.add(subject);
		const match = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*.+$/);
		let heading: string;
		if (!match) {
			heading = OTHER_HEADING;
		} else if (match[2] === "!") {
			heading = BREAKING_HEADING;
		} else {
			heading = headingForCommitType(match[1].toLowerCase()) ?? OTHER_HEADING;
		}
		const bucket = buckets.get(heading);
		if (bucket) bucket.push(subject);
		else buckets.set(heading, [subject]);
	}
	const sections: GroupedCommitSection[] = [];
	for (const heading of HEADING_ORDER) {
		const bucket = buckets.get(heading);
		if (bucket && bucket.length > 0) sections.push({ heading, subjects: bucket });
	}
	return sections;
}

/**
 * Render the grouped commit summary as a markdown section, or "" when there are
 * no commits. `floorLabel` is the previous published version (unprefixed) used
 * for the "N commits since vX" line, or null for the first-ever release.
 */
export function formatCommitSummary(subjects: readonly string[], floorLabel: string | null): string {
	const sections = groupCommitsByType(subjects);
	const total = sections.reduce((n, s) => n + s.subjects.length, 0);
	if (total === 0) return "";
	const since = floorLabel ? ` since v${floorLabel}` : "";
	const out: string[] = ["## What changed", "", `_${total} commit${total === 1 ? "" : "s"}${since}._`, ""];
	for (const section of sections) {
		out.push(`### ${section.heading}`, "");
		for (const subject of section.subjects) out.push(`- ${subject}`);
		out.push("");
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

/**
 * Read the non-merge commit subjects in `(floor, target]` and render the grouped
 * summary. `floor`/`version` are unprefixed; the tags are `v<floor>`/`v<version>`.
 *
 * A `git log` failure (shallow checkout with the range refs missing, no git)
 * is LOUD — a warning naming the range and the `fetch-depth: 0` fix — and yields
 * "" so the curated sections still publish. This is an additive summary, not a
 * primary mechanism, so degrading it loudly (never silently) is correct; the
 * release body is still produced from the curated CHANGELOG sections.
 */
async function summarizeCommitRange(floor: string | null, version: string): Promise<string> {
	const range = floor ? `v${floor}..v${version}` : `v${version}`;
	const res = await $`git log --no-merges --pretty=format:%s ${range}`.quiet().nothrow();
	if (res.exitCode !== 0) {
		console.warn(
			`Skipping the commit summary: \`git log ${range}\` exited ${res.exitCode}.\n` +
				`stderr: ${res.stderr.toString().trim() || "(empty)"}\n` +
				`Hint: the release_github checkout needs full history and tags (fetch-depth: 0) for the range to resolve.`,
		);
		return "";
	}
	const subjects = res.stdout
		.toString()
		.split("\n")
		.filter(line => line.trim().length > 0);
	return formatCommitSummary(subjects, floor);
}

async function loadPackageName(pkgDir: string): Promise<string> {
	try {
		const pkg = (await Bun.file(`${pkgDir}/package.json`).json()) as { name?: unknown };
		return typeof pkg.name === "string" ? pkg.name : pkgDir;
	} catch {
		return pkgDir;
	}
}

/**
 * Resolve the highest published, non-prerelease, non-draft semver tag strictly
 * below `targetVersion` via `gh release list`.
 *
 * Failure semantics:
 *   - `VEYYON_RELEASE_NOTES_FLOOR` set → honored verbatim (`""` forces null).
 *   - `gh` succeeded, no candidate < target → `null` (legitimate first-ever
 *     publish; legacy single-version output is correct).
 *   - `gh` itself failed (missing binary, missing `GH_TOKEN` in Actions,
 *     network/auth error) → throws. Letting this degrade to single-version
 *     output silently re-strands silent-tag entries (#2596 review); the CI
 *     step must die loudly so the release is rebuilt with the token wired.
 *     Local runs without `gh` should set `VEYYON_RELEASE_NOTES_FLOOR=` to opt
 *     into legacy mode explicitly.
 */
async function resolvePublishedFloorTag(targetVersion: string): Promise<string | null> {
	const override = process.env.VEYYON_RELEASE_NOTES_FLOOR;
	if (override !== undefined) {
		const stripped = override.replace(/^v/, "").trim();
		return stripped.length === 0 ? null : stripped;
	}
	const res =
		await $`gh release list --repo ${REPO} --limit 200 --exclude-drafts --exclude-pre-releases --json tagName,isDraft,isPrerelease`
			.quiet()
			.nothrow();
	if (res.exitCode !== 0) {
		const stderr = res.stderr.toString().trim();
		throw new Error(
			`gh release list exited ${res.exitCode}.\nstderr: ${stderr || "(empty)"}\n` +
				`Hint: in GitHub Actions, pass GH_TOKEN: \${{ secrets.GITHUB_TOKEN }} to this step. ` +
				`Locally without gh, set VEYYON_RELEASE_NOTES_FLOOR= to fall back to single-version notes.`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(res.stdout.toString());
	} catch (err) {
		throw new Error(`gh release list returned non-JSON output: ${(err as Error).message}`);
	}
	if (!Array.isArray(raw)) {
		throw new Error(`gh release list returned a non-array payload: ${typeof raw}`);
	}
	const candidates = (raw as Array<{ tagName?: unknown; isDraft?: unknown; isPrerelease?: unknown }>)
		.filter(t => t.isDraft !== true && t.isPrerelease !== true)
		.map(t => (typeof t.tagName === "string" ? t.tagName : ""))
		.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
		.filter(tag => compareVersions(tag, targetVersion) < 0)
		.sort((a, b) => compareVersions(b, a));
	return candidates[0]?.replace(/^v/, "") ?? null;
}

async function main(): Promise<void> {
	const tagInput = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
	if (!tagInput) {
		console.error("Error: version not provided. Pass as argv (e.g. `v15.4.3`) or set GITHUB_REF_NAME.");
		process.exit(1);
	}
	const version = tagInput.replace(/^v/, "").trim();
	const outputPath = process.argv[3] ?? "release-notes.md";
	const floor = await resolvePublishedFloorTag(version);
	if (floor) {
		console.log(`Aggregating CHANGELOG sections in (${floor}, ${version}].`);
	} else {
		console.log(`No prior published release resolved; emitting only ## [${version}] sections.`);
	}

	const sections: string[] = [];
	const changelogPaths = await Array.fromAsync(changelogGlob.scan("."));
	changelogPaths.sort();
	for (const changelogPath of changelogPaths) {
		const content = await Bun.file(changelogPath).text();
		const merged = mergePackageSection(content, floor, version);
		if (merged === "") continue;
		const pkgDir = changelogPath.replace(/\/CHANGELOG\.md$/, "");
		const name = await loadPackageName(pkgDir);
		sections.push(`## ${name}\n\n${merged}`);
	}

	// Derived commit-history overview for the release range. Additive: it follows
	// the curated per-package sections, and it carries the body on its own when a
	// release has no hand-written CHANGELOG bullets (the "400 commits says nothing"
	// case) so no release ever ships an empty body when real commits landed.
	const commitSummary = await summarizeCommitRange(floor, version);

	if (sections.length === 0 && commitSummary === "") {
		console.warn(
			`No CHANGELOG entries or commits found for version ${version}; writing empty release notes to ${outputPath}.`,
		);
		await Bun.write(outputPath, "");
		process.exit(0);
	}

	const parts = [...sections];
	if (commitSummary !== "") parts.push(commitSummary);
	const body = `${parts.join("\n\n")}\n`;
	await Bun.write(outputPath, body);
	console.log(
		`Wrote ${sections.length} package section(s)${commitSummary ? " + commit summary" : ""} to ${outputPath} ` +
			`(version ${version}${floor ? `, floor ${floor}` : ""}).`,
	);
}

if (import.meta.main) {
	await main();
}
