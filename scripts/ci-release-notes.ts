#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { $ } from "bun";
import { versionHeadings } from "./changelog-unreleased";
import { typeScriptMembersOf } from "./workspace-layout";

function memberChangelogPaths(): string[] {
	return typeScriptMembersOf(process.cwd())
		.map(m => `${m}/CHANGELOG.md`)
		.filter(existsSync)
		.sort();
}

const REPO = process.env.VEYYON_REPO ?? process.env.GITHUB_REPOSITORY ?? "santhreal/veyyon";
export const RELEASE_NOTES_BODY_LIMIT = 120_000;
const CATEGORY_ORDER = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;

export interface ChangelogVersionSpan {
	version: string;
	start: number;
	end: number;
}

export function enumerateChangelogVersions(content: string): ChangelogVersionSpan[] {
	const lines = content.split("\n");
	const headingIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## [")) headingIdx.push(i);
	}
	const versions = new Map(versionHeadings(content).map(h => [h.line - 1, h.version]));
	const spans: ChangelogVersionSpan[] = [];
	for (const idx of headingIdx) {
		const version = versions.get(idx);
		if (version === undefined) continue;
		spans.push({ version, start: idx, end: headingIdx.find(j => j > idx) ?? lines.length });
	}
	return spans;
}

export function mergePackageSection(content: string, versionsInRange: readonly string[]): string {
	if (versionsInRange.length === 0) return "";
	const spansByVersion = new Map(enumerateChangelogVersions(content).map(s => [s.version, s]));
	const selectedSpans = versionsInRange
		.map(v => spansByVersion.get(v.replace(/^v/, "").trim()))
		.filter((s): s is ChangelogVersionSpan => s !== undefined);
	if (selectedSpans.length === 0) return "";

	const lines = content.split("\n");
	const seenCategories: string[] = [];
	const buckets = new Map<string, string[]>();
	const seenLines = new Set<string>();

	for (const span of selectedSpans) {
		let currentCat: string | null = null;
		let buf: string[] = [];
		const flush = () => {
			if (currentCat === null || buf.length === 0) return;
			const categoryLines = buckets.get(currentCat) ?? [];
			for (const line of buf) {
				if (!seenLines.has(line)) {
					seenLines.add(line);
					categoryLines.push(line);
				}
			}
			buckets.set(currentCat, categoryLines);
			buf = [];
		};

		for (let i = span.start + 1; i < span.end; i++) {
			const line = lines[i]!;
			if (line.startsWith("### ")) {
				flush();
				currentCat = line.slice(4).trim();
				if (!seenCategories.includes(currentCat)) seenCategories.push(currentCat);
			} else if (currentCat !== null) {
				buf.push(line);
			}
		}
		flush();
	}

	const known = CATEGORY_ORDER.filter(cat => buckets.has(cat));
	const unknown = seenCategories
		.filter(cat => !CATEGORY_ORDER.includes(cat as (typeof CATEGORY_ORDER)[number]))
		.sort();
	const out: string[] = [];
	for (const cat of [...known, ...unknown]) {
		const raw = (buckets.get(cat) ?? []).join("\n").trimEnd();
		if (raw.length > 0) out.push(`### ${cat}\n\n${raw}`);
	}
	return out.join("\n\n");
}

export interface ReleaseNotesBoundOptions {
	version: string;
	floor: string | null;
	maxChars?: number;
}

export function boundReleaseNotesBody(body: string, options: ReleaseNotesBoundOptions): string {
	const maxChars = options.maxChars ?? RELEASE_NOTES_BODY_LIMIT;
	if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
		throw new Error(`Release-notes maxChars must be a positive safe integer, received ${maxChars}.`);
	}
	if (body.length <= maxChars) return body;

	const tag = `v${options.version.replace(/^v/, "")}`;
	const rangeUrl = options.floor
		? `https://github.com/${REPO}/compare/v${options.floor.replace(/^v/, "")}...${tag}`
		: `https://github.com/${REPO}/commits/${tag}`;
	const notice = `_Release notes were shortened from ${body.length.toLocaleString("en-US")} characters to fit GitHub's 125,000-character body limit. Read the [complete changelog](https://github.com/${REPO}/blob/${tag}/CHANGELOG.md) and [full commit range](${rangeUrl})._`;
	const prefixBudget = maxChars - notice.length - 2;
	if (prefixBudget <= 0)
		throw new Error(`Release-notes maxChars ${maxChars} is too small for the ${notice.length}-character notice.`);

	const bulletStarts = [...body.matchAll(/(?:^|\n)- /g)]
		.map(m => (m.index ?? 0) + (m[0].startsWith("\n") ? 1 : 0))
		.filter(i => i <= prefixBudget);
	const lines = (bulletStarts.length > 0 ? body.slice(0, bulletStarts[bulletStarts.length - 1]) : "")
		.trimEnd()
		.split("\n");
	while (lines.length > 0) {
		while (lines.at(-1)?.trim() === "") lines.pop();
		if (lines.at(-1)?.match(/^#{2,3} /)) {
			lines.pop();
			continue;
		}
		break;
	}
	const bounded = lines.length ? `${lines.join("\n").trimEnd()}\n\n${notice}\n` : `${notice}\n`;
	if (bounded.length > maxChars)
		throw new Error(`Bounded release notes are ${bounded.length} characters, above the ${maxChars} limit.`);
	return bounded;
}

const COMMIT_TYPE_HEADINGS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^feat$/, "Features"],
	[/^fix$/, "Fixes"],
	[/^perf$/, "Performance"],
	[/^refactor$/, "Refactors"],
	[/^revert$/, "Reverts"],
	[/^docs$/, "Documentation"],
	[/^test$/, "Tests"],
	[/^(build|ci)$/, "Build & CI"],
	[/^chore|style$/, "Chores"],
];
const BREAKING_HEADING = "Breaking Changes";
const OTHER_HEADING = "Other changes";
const HEADING_ORDER = [BREAKING_HEADING, ...COMMIT_TYPE_HEADINGS.map(([, h]) => h), OTHER_HEADING] as const;

export interface GroupedCommitSection {
	heading: string;
	subjects: string[];
}

export function groupCommitsByType(subjects: readonly string[]): GroupedCommitSection[] {
	const buckets = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const raw of subjects) {
		const subject = raw.trim();
		if (!subject || seen.has(subject)) continue;
		seen.add(subject);
		const match = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*.+$/);
		const heading = !match
			? OTHER_HEADING
			: match[2] === "!"
				? BREAKING_HEADING
				: (COMMIT_TYPE_HEADINGS.find(([p]) => p.test(match[1].toLowerCase()))?.[1] ?? OTHER_HEADING);
		const bucket = buckets.get(heading) ?? [];
		bucket.push(subject);
		buckets.set(heading, bucket);
	}
	return HEADING_ORDER.filter(h => (buckets.get(h) ?? []).length > 0).map(heading => ({
		heading,
		subjects: buckets.get(heading)!,
	}));
}

export function formatCommitSummary(subjects: readonly string[], floorLabel: string | null): string {
	const sections = groupCommitsByType(subjects);
	const total = sections.reduce((n, s) => n + s.subjects.length, 0);
	if (total === 0) return "";
	const out: string[] = [
		"## What changed",
		"",
		`_${total} commit${total === 1 ? "" : "s"}${floorLabel ? ` since v${floorLabel}` : ""}._`,
		"",
	];
	for (const s of sections) {
		out.push(`### ${s.heading}`, "", ...s.subjects.map(sub => `- ${sub}`), "");
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

async function summarizeCommitRange(floor: string | null, version: string): Promise<string> {
	const range = floor ? `v${floor}..v${version}` : `v${version}`;
	const res = await $`git log --no-merges --pretty=format:%s ${range}`.quiet().nothrow();
	if (res.exitCode !== 0) {
		console.warn(
			`Skipping the commit summary: \`git log ${range}\` exited ${res.exitCode}.\nstderr: ${res.stderr.toString().trim() || "(empty)"}\nHint: fetch-depth: 0 needed.`,
		);
		return "";
	}
	return formatCommitSummary(
		res.stdout
			.toString()
			.split("\n")
			.filter(l => l.trim().length > 0),
		floor,
	);
}

async function loadPackageName(pkgDir: string): Promise<string> {
	try {
		const pkg = (await Bun.file(`${pkgDir}/package.json`).json()) as { name?: unknown };
		return typeof pkg.name === "string" ? pkg.name : pkgDir;
	} catch {
		return pkgDir;
	}
}

export function resolvePublishedFloorFromList(
	rawReleases: readonly { tagName?: unknown; isDraft?: unknown; isPrerelease?: unknown; publishedAt?: unknown }[],
	targetVersion: string,
): { floor: string | null; versionsInRange: string[] } {
	const target = targetVersion.replace(/^v/, "").trim();
	const ordered = rawReleases
		.filter(
			t =>
				t.isDraft !== true &&
				t.isPrerelease !== true &&
				typeof t.tagName === "string" &&
				/^v\d+\.\d+\.\d+$/.test(t.tagName),
		)
		.map(t => ({
			version: (t.tagName as string).replace(/^v/, "").trim(),
			publishedAt: typeof t.publishedAt === "string" ? t.publishedAt : "",
		}))
		.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

	const floorIdx = ordered.findIndex(r => r.version !== target);
	if (floorIdx === -1) return { floor: null, versionsInRange: [target] };
	return {
		floor: ordered[floorIdx]!.version,
		versionsInRange: [
			target,
			...ordered
				.slice(0, floorIdx)
				.map(r => r.version)
				.filter(v => v !== target),
		],
	};
}

export async function resolvePublishedFloorTag(
	targetVersion: string,
): Promise<{ floor: string | null; versionsInRange: string[] }> {
	const target = targetVersion.replace(/^v/, "").trim();
	const override = process.env.VEYYON_RELEASE_NOTES_FLOOR;
	if (override !== undefined) {
		const stripped = override.replace(/^v/, "").trim();
		const floor = stripped.length === 0 ? null : stripped;
		return { floor, versionsInRange: floor !== null && floor === target ? [] : [target] };
	}
	const res =
		await $`gh release list --repo ${REPO} --limit 200 --exclude-drafts --exclude-pre-releases --json tagName,isDraft,isPrerelease,publishedAt`
			.quiet()
			.nothrow();
	if (res.exitCode !== 0)
		throw new Error(
			`gh release list exited ${res.exitCode}.\nstderr: ${res.stderr.toString().trim() || "(empty)"}\nHint: pass GH_TOKEN.`,
		);
	const raw = JSON.parse(res.stdout.toString());
	if (!Array.isArray(raw)) throw new Error(`gh release list returned a non-array payload: ${typeof raw}`);
	return resolvePublishedFloorFromList(raw, target);
}

async function main(): Promise<void> {
	const tagInput = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
	if (!tagInput) {
		console.error("Error: version not provided. Pass as argv (e.g. `v15.4.3`) or set GITHUB_REF_NAME.");
		process.exit(1);
	}
	const version = tagInput.replace(/^v/, "").trim();
	const outputPath = process.argv[3] ?? "release-notes.md";
	const { floor, versionsInRange } = await resolvePublishedFloorTag(version);
	console.log(
		floor
			? `Aggregating CHANGELOG sections for [${versionsInRange.join(", ")}] (floor: ${floor}).`
			: `No prior published release resolved; emitting only ## [${version}] sections.`,
	);

	const sections: string[] = [];
	for (const changelogPath of memberChangelogPaths()) {
		const merged = mergePackageSection(await Bun.file(changelogPath).text(), versionsInRange);
		if (merged)
			sections.push(`## ${await loadPackageName(changelogPath.replace(/\/CHANGELOG\.md$/, ""))}\n\n${merged}`);
	}

	const commitSummary = await summarizeCommitRange(floor, version);
	if (sections.length === 0 && commitSummary === "") {
		console.warn(
			`No CHANGELOG entries or commits found for version ${version}; writing empty release notes to ${outputPath}.`,
		);
		await Bun.write(outputPath, "");
		process.exit(0);
	}

	const parts = [...sections];
	if (commitSummary) parts.push(commitSummary);
	const unboundedBody = `${parts.join("\n\n")}\n`;
	const body = boundReleaseNotesBody(unboundedBody, { version, floor });
	if (body.length < unboundedBody.length) {
		console.warn(
			`Release notes exceeded GitHub's body limit: shortened ${unboundedBody.length.toLocaleString("en-US")} characters to ${body.length.toLocaleString("en-US")} at a complete bullet boundary.`,
		);
	}
	await Bun.write(outputPath, body);
	console.log(
		`Wrote ${sections.length} package section(s)${commitSummary ? " + commit summary" : ""} to ${outputPath} (version ${version}${floor ? `, floor ${floor}` : ""}, ${body.length.toLocaleString("en-US")} characters).`,
	);
}

if (import.meta.main) {
	await main();
}
