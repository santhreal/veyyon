#!/usr/bin/env bun
import { existsSync } from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { typeScriptMembersOf } from "./workspace-layout";

const ORDERED_SECTION_TITLES = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;
const CHANGELOG_BASELINE_REF = "refs/clog";
const CHANGELOG_BASELINE_NAME = "clog";

export interface NumberedLine {
	text: string;
	lineNumber: number;
}
export interface Subsection {
	title: string;
	lines: NumberedLine[];
}
export interface ReleaseSection {
	heading: string;
	title: string;
	leadingLines: NumberedLine[];
	subsections: Subsection[];
}
export interface ChangelogDocument {
	prefixLines: NumberedLine[];
	sections: ReleaseSection[];
}
export interface ParsedItem {
	startLine: number;
	endLine: number;
	lines: string[];
}

interface FixCounters {
	promotedItems: number;
	mergedDuplicateHeadings: number;
	mergedDuplicateVersions: number;
	removedEmptyHeadings: number;
	droppedReleasedDuplicates: number;
}
export interface FixChangelogContentResult extends FixCounters {
	content: string;
}
interface HunkRef {
	path: string;
	index: number;
}
interface AddedItemCandidate {
	path: string;
	lineNumber: number;
	text: string;
	hunk: HunkRef;
	pairedWithRemoval: boolean;
}
interface RemovedItemOccurrence {
	path: string;
	text: string;
	hunk: HunkRef;
	pairedWithAddition: boolean;
}
export interface ChangedChangelogSummary extends FixCounters {
	path: string;
}
export interface RunChangelogFixerOptions {
	repoRoot?: string;
	since?: string;
	write?: boolean;
	recover?: boolean;
}
export interface RunChangelogFixerResult {
	since: string;
	changedFiles: ChangedChangelogSummary[];
}
interface CliOptions {
	mode: "write" | "dry-run" | "check";
	repoRoot?: string;
	since?: string;
	recover: boolean;
	pin: boolean;
	help: boolean;
}
interface HistoricalReleaseRecovery {
	itemKeys: Set<string>;
	sectionsByTitle: Map<string, ReleaseSection>;
}

const isReleaseHeading = (line: string) => /^## \[[^\]]+\]/.test(line);
const isSubsectionHeading = (line: string) => /^###\s+\S/.test(line);
const parseReleaseTitle = (h: string) => h.match(/^## \[([^\]]+)\]/)?.[1] ?? h.replace(/^##\s+/, "").trim();
const parseSubsectionTitle = (h: string) => h.replace(/^###\s+/, "").trim();
const isListItemLine = (line: string) => line.trimStart().startsWith("- ");
const normalizeItemText = (text: string) => text.trim();

function splitContentLines(content: string): string[] {
	const n = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return n.endsWith("\n") ? n.slice(0, -1).split("\n") : n.split("\n");
}

export function parseChangelog(content: string): ChangelogDocument {
	const numberedLines = splitContentLines(content).map((text, idx) => ({ text, lineNumber: idx + 1 }));
	const prefixLines: NumberedLine[] = [];
	const sections: ReleaseSection[] = [];
	let i = 0;
	while (i < numberedLines.length && !isReleaseHeading(numberedLines[i]?.text ?? ""))
		prefixLines.push(numberedLines[i++]!);
	while (i < numberedLines.length) {
		const headingLine = numberedLines[i++]!;
		const bodyLines: NumberedLine[] = [];
		while (i < numberedLines.length && !isReleaseHeading(numberedLines[i]?.text ?? ""))
			bodyLines.push(numberedLines[i++]!);
		sections.push(parseReleaseSection(headingLine.text, bodyLines));
	}
	return { prefixLines, sections };
}

function parseReleaseSection(heading: string, bodyLines: readonly NumberedLine[]): ReleaseSection {
	const leadingLines: NumberedLine[] = [];
	const subsections: Subsection[] = [];
	let i = 0;
	while (i < bodyLines.length && !isSubsectionHeading(bodyLines[i]?.text ?? "")) leadingLines.push(bodyLines[i++]!);
	while (i < bodyLines.length) {
		const headingLine = bodyLines[i++]!;
		const lines: NumberedLine[] = [];
		while (i < bodyLines.length && !isSubsectionHeading(bodyLines[i]?.text ?? "")) lines.push(bodyLines[i++]!);
		subsections.push({ title: parseSubsectionTitle(headingLine.text), lines });
	}
	return { heading, title: parseReleaseTitle(heading), leadingLines, subsections };
}

function trimBlankLines(lines: readonly string[]): string[] {
	let s = 0;
	let e = lines.length;
	while (s < e && lines[s]?.trim() === "") s++;
	while (e > s && lines[e - 1]?.trim() === "") e--;
	return lines.slice(s, e);
}

const numberedText = (lines: readonly NumberedLine[]) => lines.map(l => l.text);
const syntheticLines = (lines: readonly string[]) => lines.map(text => ({ text, lineNumber: 0 }));

function appendSubsectionLines(target: Subsection, sourceLines: readonly string[]) {
	const trimmed = trimBlankLines(sourceLines);
	if (!trimmed.length) return;
	const existing = trimBlankLines(numberedText(target.lines));
	if (!existing.length) {
		target.lines = syntheticLines(trimmed);
		return;
	}
	const sep = isListItemLine(existing[existing.length - 1] ?? "") && isListItemLine(trimmed[0] ?? "") ? [] : [""];
	target.lines = syntheticLines([...existing, ...sep, ...trimmed]);
}

export function parseItems(lines: readonly NumberedLine[]): ParsedItem[] {
	const items: ParsedItem[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!isListItemLine(lines[i]?.text ?? "")) {
			i++;
			continue;
		}
		const start = i++;
		while (i < lines.length && !isListItemLine(lines[i]?.text ?? "")) i++;
		const chunk = lines.slice(start, i);
		items.push({
			startLine: chunk[0]!.lineNumber,
			endLine: chunk[chunk.length - 1]!.lineNumber,
			lines: trimBlankLines(numberedText(chunk)),
		});
	}
	return items;
}

export function lineRangeSet(items: readonly ParsedItem[]): Set<number> {
	const lines = new Set<number>();
	for (const item of items) {
		for (let l = item.startLine; l <= item.endLine; l++) lines.add(l);
	}
	return lines;
}

const itemTextKey = (itemLines: readonly string[]) => trimBlankLines(itemLines).join("\n");
const subsectionHasItem = (sub: Subsection, itemLines: readonly string[]) => {
	const wanted = itemTextKey(itemLines);
	return !wanted || parseItems(sub.lines).some(item => itemTextKey(item.lines) === wanted);
};

function collectReleasedItemKeys(document: ChangelogDocument): Set<string> {
	const keys = new Set<string>();
	for (const sec of document.sections) {
		if (sec.title === "Unreleased") continue;
		for (const sub of sec.subsections) {
			for (const it of parseItems(sub.lines)) {
				const k = itemTextKey(it.lines);
				if (k) keys.add(k);
			}
		}
	}
	return keys;
}

function dropUnreleasedDuplicatesOfReleased(
	document: ChangelogDocument,
	historicalReleasedItemKeys: ReadonlySet<string> = new Set<string>(),
): number {
	const unreleased = document.sections.find(s => s.title === "Unreleased");
	if (!unreleased) return 0;
	const releasedKeys = collectReleasedItemKeys(document);
	for (const k of historicalReleasedItemKeys) releasedKeys.add(k);
	if (!releasedKeys.size) return 0;
	let dropped = 0;
	for (const sub of unreleased.subsections) {
		const dups = parseItems(sub.lines).filter(it => releasedKeys.has(itemTextKey(it.lines)));
		if (!dups.length) continue;
		const toRemove = lineRangeSet(dups);
		sub.lines = sub.lines.filter(l => !toRemove.has(l.lineNumber));
		dropped += dups.length;
	}
	return dropped;
}

function getOrCreateUnreleasedSection(document: ChangelogDocument): ReleaseSection {
	const existing = document.sections.find(s => s.title === "Unreleased");
	if (existing) return existing;
	const section: ReleaseSection = {
		heading: "## [Unreleased]",
		title: "Unreleased",
		leadingLines: [],
		subsections: [],
	};
	document.sections.unshift(section);
	return section;
}

function getOrCreateSubsection(section: ReleaseSection, title: string): Subsection {
	const existing = section.subsections.findLast(s => s.title === title);
	if (existing) return existing;
	const sub: Subsection = { title, lines: [] };
	section.subsections.push(sub);
	return sub;
}

function titleOrder(title: string): number {
	const idx = ORDERED_SECTION_TITLES.indexOf(title as (typeof ORDERED_SECTION_TITLES)[number]);
	return idx === -1 ? ORDERED_SECTION_TITLES.length : idx;
}

function compactAdjacentListSpacing(lines: readonly string[]): string[] {
	const trimmed = trimBlankLines(lines);
	if (!trimmed.length) return [];
	const parsed = parseItems(syntheticLines(trimmed));
	if (!parsed.length) return [...trimmed];
	const flattened = parsed.flatMap(it => it.lines);
	const orig = trimmed.filter(l => l.trim() !== "");
	const flat = flattened.filter(l => l.trim() !== "");
	return orig.length === flat.length && orig.every((l, i) => l === flat[i]) ? flattened : [...trimmed];
}

function normalizeSection(section: ReleaseSection): FixCounters {
	const counters: FixCounters = {
		promotedItems: 0,
		mergedDuplicateHeadings: 0,
		mergedDuplicateVersions: 0,
		removedEmptyHeadings: 0,
		droppedReleasedDuplicates: 0,
	};
	const byTitle = new Map<string, Subsection>();
	const normalized: Subsection[] = [];
	for (const sub of section.subsections) {
		const trimmed = compactAdjacentListSpacing(trimBlankLines(numberedText(sub.lines)));
		if (!trimmed.length) {
			counters.removedEmptyHeadings++;
			continue;
		}
		const ex = byTitle.get(sub.title);
		if (ex) {
			appendSubsectionLines(ex, trimmed);
			counters.mergedDuplicateHeadings++;
			continue;
		}
		const norm: Subsection = { title: sub.title, lines: syntheticLines(trimmed) };
		byTitle.set(sub.title, norm);
		normalized.push(norm);
	}
	if (section.title === "Unreleased") normalized.sort((a, b) => titleOrder(a.title) - titleOrder(b.title));
	section.leadingLines = syntheticLines(trimBlankLines(numberedText(section.leadingLines)));
	section.subsections = normalized;
	return counters;
}

function cloneReleaseSection(sec: ReleaseSection): ReleaseSection {
	return {
		heading: sec.heading,
		title: sec.title,
		leadingLines: syntheticLines(trimBlankLines(numberedText(sec.leadingLines))),
		subsections: sec.subsections.map(s => ({
			title: s.title,
			lines: syntheticLines(trimBlankLines(numberedText(s.lines))),
		})),
	};
}

const sectionHasContent = (sec: ReleaseSection) =>
	trimBlankLines(numberedText(sec.leadingLines)).length > 0 ||
	sec.subsections.some(s => trimBlankLines(numberedText(s.lines)).length > 0);

function mergeDuplicateVersionSections(document: ChangelogDocument): number {
	const firstByTitle = new Map<string, ReleaseSection>();
	const kept: ReleaseSection[] = [];
	let merged = 0;
	for (const sec of document.sections) {
		const first = firstByTitle.get(sec.title);
		if (!first) {
			firstByTitle.set(sec.title, sec);
			kept.push(sec);
			continue;
		}
		const inLead = trimBlankLines(numberedText(sec.leadingLines));
		if (inLead.length) {
			const exLead = trimBlankLines(numberedText(first.leadingLines));
			if (exLead.join("\n") !== inLead.join("\n"))
				first.leadingLines = syntheticLines(exLead.length ? [...exLead, "", ...inLead] : inLead);
		}
		for (const sub of sec.subsections) {
			const target = getOrCreateSubsection(first, sub.title);
			for (const it of parseItems(sub.lines)) {
				if (!subsectionHasItem(target, it.lines)) appendSubsectionLines(target, it.lines);
			}
		}
		merged++;
	}
	document.sections = kept;
	return merged;
}

function sortReleaseSections(document: ChangelogDocument) {
	document.sections = [
		...document.sections.filter(s => s.title === "Unreleased"),
		...document.sections.filter(s => s.title !== "Unreleased"),
	];
}

function rebuildReleasedSectionsFromHistory(
	content: string,
	historicalSectionsByTitle: ReadonlyMap<string, ReleaseSection>,
): string {
	if (!historicalSectionsByTitle.size) return content;
	const doc = parseChangelog(content);
	const unreleased: ReleaseSection[] = [];
	const released: ReleaseSection[] = [];
	const seen = new Set<string>();
	for (const sec of doc.sections) {
		if (sec.title === "Unreleased") {
			unreleased.push(sec);
			continue;
		}
		if (seen.has(sec.title)) continue;
		seen.add(sec.title);
		const hist = historicalSectionsByTitle.get(sec.title);
		if (hist) {
			released.push({
				heading: sec.heading,
				title: sec.title,
				leadingLines: syntheticLines(trimBlankLines(numberedText(hist.leadingLines))),
				subsections: hist.subsections.map(s => ({
					title: s.title,
					lines: syntheticLines(trimBlankLines(numberedText(s.lines))),
				})),
			});
		} else {
			released.push(sec);
		}
	}
	for (const [title, sec] of historicalSectionsByTitle) {
		if (!seen.has(title)) released.push(cloneReleaseSection(sec));
	}
	doc.sections = [...unreleased, ...released];
	sortReleaseSections(doc);
	return renderChangelog(doc);
}

export function renderChangelog(document: ChangelogDocument): string {
	const out: string[] = [];
	const pfx = trimBlankLines(numberedText(document.prefixLines));
	if (pfx.length) out.push(...pfx, "");
	for (const sec of document.sections) {
		out.push(sec.heading);
		const lead = trimBlankLines(numberedText(sec.leadingLines));
		if (lead.length) out.push("", ...lead);
		for (const sub of sec.subsections) {
			const l = trimBlankLines(numberedText(sub.lines));
			if (!l.length) continue;
			out.push("", `### ${sub.title}`, "", ...l);
		}
		out.push("");
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	return `${out.join("\n")}\n`;
}

export function fixChangelogContent(
	content: string,
	promotableAddedItemStartLines: ReadonlySet<number>,
	historicalReleasedItemKeys: ReadonlySet<string> = new Set<string>(),
): FixChangelogContentResult {
	const doc = parseChangelog(content);
	let unreleased = doc.sections.find(s => s.title === "Unreleased");
	let promotedItems = 0;
	const droppedReleasedDuplicates = dropUnreleasedDuplicatesOfReleased(doc, historicalReleasedItemKeys);

	for (const sec of doc.sections) {
		if (sec.title === "Unreleased") continue;
		for (const sub of sec.subsections) {
			const items = parseItems(sub.lines).filter(it => promotableAddedItemStartLines.has(it.startLine));
			if (!items.length) continue;
			const toRemove = lineRangeSet(items);
			sub.lines = sub.lines.filter(l => !toRemove.has(l.lineNumber));
			unreleased ??= getOrCreateUnreleasedSection(doc);
			const targetSub = getOrCreateSubsection(unreleased, sub.title);
			for (const it of items) {
				if (!subsectionHasItem(targetSub, it.lines)) appendSubsectionLines(targetSub, it.lines);
				promotedItems++;
			}
		}
	}

	const mergedDuplicateVersions = mergeDuplicateVersionSections(doc);
	let mergedDuplicateHeadings = 0;
	let removedEmptyHeadings = 0;
	for (const sec of doc.sections) {
		const c = normalizeSection(sec);
		mergedDuplicateHeadings += c.mergedDuplicateHeadings;
		removedEmptyHeadings += c.removedEmptyHeadings;
	}
	sortReleaseSections(doc);
	return {
		content: renderChangelog(doc),
		promotedItems,
		mergedDuplicateHeadings,
		mergedDuplicateVersions,
		removedEmptyHeadings,
		droppedReleasedDuplicates,
	};
}

const hunkKey = (hunk: HunkRef) => `${hunk.path}\0${hunk.index}`;
const isAddedReleaseHeadingLine = (line: string) => line.startsWith("+## [");
const itemKey = (p: string, t: string) => `${p}\0${normalizeItemText(t)}`;

export function collectPromotableAddedItemLines(diffText: string): Map<string, Set<number>> {
	const candidates: AddedItemCandidate[] = [];
	const removals: RemovedItemOccurrence[] = [];
	const addedReleaseHeadingHunks = new Set<string>();
	let curPath = "";
	let newLine = 0;
	let hunkIdx = -1;

	for (const raw of diffText.replace(/\r\n/g, "\n").split("\n")) {
		if (raw.startsWith("+++ b/")) {
			curPath = raw.slice(6);
			continue;
		}
		if (raw.startsWith("diff --git ")) {
			curPath = "";
			hunkIdx = -1;
			continue;
		}
		const hm = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hm) {
			newLine = Number(hm[2]);
			hunkIdx++;
			continue;
		}
		if (!curPath || hunkIdx < 0 || !raw.length) continue;
		const marker = raw[0];
		const text = raw.slice(1);
		const hunk = { path: curPath, index: hunkIdx };
		if (marker === "+") {
			if (isAddedReleaseHeadingLine(raw)) addedReleaseHeadingHunks.add(hunkKey(hunk));
			if (isListItemLine(text))
				candidates.push({ path: curPath, lineNumber: newLine, text, hunk, pairedWithRemoval: false });
			newLine++;
		} else if (marker === "-") {
			if (isListItemLine(text)) removals.push({ path: curPath, text, hunk, pairedWithAddition: false });
		} else if (marker === " ") {
			newLine++;
		}
	}

	const removalsByItem = new Map<string, RemovedItemOccurrence[]>();
	for (const r of removals) {
		const k = itemKey(r.path, r.text);
		const list = removalsByItem.get(k) ?? [];
		list.push(r);
		removalsByItem.set(k, list);
	}

	for (const c of candidates) {
		const match = removalsByItem.get(itemKey(c.path, c.text))?.find(r => !r.pairedWithAddition);
		if (match) {
			match.pairedWithAddition = true;
			c.pairedWithRemoval = true;
		}
	}

	const unpairedCount = new Map<string, number>();
	for (const r of removals) {
		if (r.pairedWithAddition) continue;
		const k = hunkKey(r.hunk);
		unpairedCount.set(k, (unpairedCount.get(k) ?? 0) + 1);
	}

	const linesByPath = new Map<string, Set<number>>();
	for (const c of candidates) {
		const k = hunkKey(c.hunk);
		if (c.pairedWithRemoval || addedReleaseHeadingHunks.has(k)) continue;
		const unp = unpairedCount.get(k) ?? 0;
		if (unp > 0) {
			unpairedCount.set(k, unp - 1);
			continue;
		}
		const set = linesByPath.get(c.path) ?? new Set<number>();
		set.add(c.lineNumber);
		linesByPath.set(c.path, set);
	}
	return linesByPath;
}

const git = async (args: readonly string[], cwd: string) =>
	(
		await $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`
			.cwd(cwd)
			.quiet()
	).text();
const gitMaybe = async (args: readonly string[], cwd: string) => {
	const res = await $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`
		.cwd(cwd)
		.quiet()
		.nothrow();
	return res.exitCode === 0 ? res.text() : undefined;
};

export async function resolveRepoRoot(repoRoot: string | undefined): Promise<string> {
	return repoRoot ? path.resolve(repoRoot) : (await git(["rev-parse", "--show-toplevel"], process.cwd())).trim();
}

async function resolveSince(repoRoot: string, since: string | undefined): Promise<string> {
	if (since) return since;
	const versionTag = ((await gitMaybe(["describe", "--tags", "--abbrev=0", "--match", "v*"], repoRoot)) ?? "").trim();
	const baseline =
		(await gitMaybe(["rev-parse", "--verify", "--quiet", CHANGELOG_BASELINE_REF], repoRoot))?.trim() || undefined;
	if (!baseline) return versionTag;
	if (!versionTag) return CHANGELOG_BASELINE_REF;
	return (await gitMaybe(["merge-base", "--is-ancestor", baseline, versionTag], repoRoot)) !== undefined
		? versionTag
		: CHANGELOG_BASELINE_REF;
}

async function recoveryTags(repoRoot: string): Promise<string[]> {
	const baseline =
		(await gitMaybe(["rev-parse", "--verify", "--quiet", CHANGELOG_BASELINE_REF], repoRoot))?.trim() || undefined;
	const listArgs = baseline ? ["tag", "--contains", baseline, "--sort=v:refname"] : ["tag", "--sort=v:refname"];
	return (await git(listArgs, repoRoot))
		.split("\n")
		.map(t => t.trim())
		.filter(t => t.length > 0);
}

async function collectHistoricalReleaseRecovery(
	repoRoot: string,
	paths: readonly string[],
): Promise<Map<string, HistoricalReleaseRecovery>> {
	const tags = await recoveryTags(repoRoot);
	const recoveryByPath = new Map<string, HistoricalReleaseRecovery>();
	for (const tag of tags) {
		for (const p of paths) {
			const content = await gitMaybe(["show", `${tag}:${p}`], repoRoot);
			if (content === undefined) continue;
			const doc = parseChangelog(content);
			let recovery = recoveryByPath.get(p);
			for (const sec of doc.sections) {
				if (sec.title === "Unreleased" || !sectionHasContent(sec)) continue;
				if (!recovery) {
					recovery = { itemKeys: new Set(), sectionsByTitle: new Map() };
					recoveryByPath.set(p, recovery);
				}
				if (!recovery.sectionsByTitle.has(sec.title))
					recovery.sectionsByTitle.set(sec.title, cloneReleaseSection(sec));
				for (const sub of sec.subsections) {
					for (const it of parseItems(sub.lines)) recovery.itemKeys.add(itemTextKey(it.lines));
				}
			}
		}
	}
	return recoveryByPath;
}

export async function changelogPaths(repoRoot: string): Promise<string[]> {
	return typeScriptMembersOf(repoRoot)
		.map(m => `${m}/CHANGELOG.md`)
		.filter(rel => existsSync(path.join(repoRoot, rel)))
		.sort();
}

export async function runChangelogFixer(options: RunChangelogFixerOptions = {}): Promise<RunChangelogFixerResult> {
	const repoRoot = await resolveRepoRoot(options.repoRoot);
	const since = await resolveSince(repoRoot, options.since);
	const paths = await changelogPaths(repoRoot);
	const diff =
		paths.length && since
			? await git(["diff", "--unified=0", "--no-color", "--no-ext-diff", since, "--", ...paths], repoRoot)
			: "";
	const addedItemLines = options.recover ? new Map<string, Set<number>>() : collectPromotableAddedItemLines(diff);
	const historicalRecoveryByPath = options.recover
		? await collectHistoricalReleaseRecovery(repoRoot, paths)
		: new Map();
	const changedFiles: ChangedChangelogSummary[] = [];

	for (const clPath of paths) {
		const abs = path.join(repoRoot, clPath);
		const cur = await Bun.file(abs).text();
		const hist = historicalRecoveryByPath.get(clPath);
		const rec = hist ? rebuildReleasedSectionsFromHistory(cur, hist.sectionsByTitle) : cur;
		const res = fixChangelogContent(rec, addedItemLines.get(clPath) ?? new Set(), hist?.itemKeys ?? new Set());
		if (res.content === cur) continue;
		changedFiles.push({ path: clPath, ...res });
		if (options.write !== false) await Bun.write(abs, res.content);
	}
	return { since, changedFiles };
}

function parseCliArgs(argv: readonly string[]): CliOptions {
	const opts: CliOptions = { mode: "write", recover: false, pin: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") opts.mode = "dry-run";
		else if (arg === "--check") opts.mode = "check";
		else if (arg === "--recover") opts.recover = true;
		else if (arg === "--pin") opts.pin = true;
		else if (arg === "--since") opts.since = argv[++i];
		else if (arg === "--repo-root") opts.repoRoot = argv[++i];
		else if (arg === "-h" || arg === "--help") opts.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return opts;
}

async function main(): Promise<void> {
	try {
		const opts = parseCliArgs(process.argv.slice(2));
		if (opts.help) {
			console.log("Usage: bun scripts/fix-changelogs.ts [--dry-run|--check] [--since <tag>] [--recover] [--pin]");
			return;
		}
		if (opts.pin) {
			const repoRoot = await resolveRepoRoot(opts.repoRoot);
			const head = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
			await git(["update-ref", CHANGELOG_BASELINE_REF, head], repoRoot);
			console.log(
				`Pinned changelog baseline '${CHANGELOG_BASELINE_NAME}' (${CHANGELOG_BASELINE_REF}) to ${head.slice(0, 12)}.`,
			);
			return;
		}
		const res = await runChangelogFixer({
			repoRoot: opts.repoRoot,
			since: opts.since,
			write: opts.mode === "write",
			recover: opts.recover,
		});
		const suffix = opts.mode === "write" ? "" : ` (${opts.mode}, not written)`;
		if (!res.changedFiles.length) console.log(`Changelogs already clean since ${res.since}.`);
		else {
			console.log(`Fixed ${res.changedFiles.length} changelog(s) since ${res.since}${suffix}:`);
			for (const f of res.changedFiles) {
				console.log(
					`  ${f.path}: ${f.promotedItems} promoted item(s), ${f.mergedDuplicateHeadings} merged duplicate heading(s), ${f.mergedDuplicateVersions} merged duplicate version(s), ${f.droppedReleasedDuplicates} dropped released duplicate(s), ${f.removedEmptyHeadings} removed empty heading(s)`,
				);
			}
		}
		if (opts.mode === "check" && res.changedFiles.length) process.exit(1);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
