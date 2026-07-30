#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Upstream radar: mirror every newly MERGED oh-my-pi PR into one porting issue
 * on this repo, labeled for the Jules async coding agent to pick up.
 *
 * Why: veyyon forked can1357/oh-my-pi and has diverged (~500 commits), but
 * upstream ships real-world bug fixes at a pace veyyon cannot manually track
 * (30 releases in 3 days). Each merged upstream PR becomes an issue carrying
 * the diff surface and porting instructions; scripts/jules-port-manager.ts
 * dispatches each issue as a Jules session via the REST API (the GitHub-app
 * `jules` label trigger never fired; the label is kept as a human-readable
 * tag only), and the session opens an adapted port PR, which autoreview.yml
 * and a human then gate. Dedup is by an HTML-comment marker
 * (`upstream-pr: <number>`) in the issue body, so re-runs are idempotent and
 * concurrent runs converge.
 *
 * What gets mirrored is policy, not everything: veyyon ports upstream fixes
 * and performance corrections, plus feature additions whose file surface does
 * not cross a known architectural divergence. The clean-feature screen is
 * deliberately conservative and only creates a review candidate; Jules still
 * has to establish product fit, tests, and local architecture before opening
 * a PR. The policy is data, not code: scripts/upstream-port-policy.json.
 *
 * Runs from .github/workflows/upstream-radar.yml on a schedule; also runnable
 * locally with GH_TOKEN set. Fails closed: any API error aborts the run with a
 * non-zero exit rather than silently skipping PRs.
 */
import { prompt } from "@veyyon/utils";
import PORT_ISSUE_TEMPLATE from "./upstream-port-issue.md" with { type: "text" };

const UPSTREAM = "can1357/oh-my-pi";
const ORIGIN = process.env.GITHUB_REPOSITORY ?? "santhreal/veyyon";
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
// Operational knobs (Tier A): env overrides with safe defaults.
const LOOKBACK_DAYS = Number(process.env.RADAR_LOOKBACK_DAYS ?? "3");
const MAX_NEW_ISSUES_PER_RUN = Number(process.env.RADAR_MAX_ISSUES ?? "10");
const PORT_LABEL = "upstream-port";
const AGENT_LABEL = "jules";

export interface DivergedSurface {
	name: string;
	paths: string[];
	note: string;
	blocksCleanFeatures?: boolean;
}

export interface PortPolicy {
	allowedTypes: string[];
	cleanFeatureTypes: string[];
	titleAllowRegexes: string[];
	cleanFeatureTitleAllowRegexes: string[];
	divergedSurfaces: DivergedSurface[];
	documentationPaths: string[];
	documentationExtensions: string[];
}

export function loadPolicy(): PortPolicy {
	const path = join(dirname(fileURLToPath(import.meta.url)), "upstream-port-policy.json");
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Conventional-commit type of a PR title (`fix(tui): ...` -> `fix`), or null. */
export function titleType(title: string): string | null {
	const m = /^([a-z]+)(?:\([^)]*\))?!?:/.exec(title.trim());
	return m ? m[1] : null;
}

export type PortCandidateKind = "fix" | "clean-feature";

/**
 * Classify the title before fetching its file list. Fix/perf changes always
 * enter semantic triage. Features proceed only to the clean-surface check.
 */
export function portCandidateKind(title: string, policy: PortPolicy): PortCandidateKind | null {
	const type = titleType(title);
	if (type !== null) {
		if (policy.allowedTypes.includes(type)) return "fix";
		if (policy.cleanFeatureTypes.includes(type)) return "clean-feature";
		return null;
	}
	const trimmed = title.trim();
	if (policy.titleAllowRegexes.some(re => new RegExp(re, "i").test(trimmed))) return "fix";
	if (policy.cleanFeatureTitleAllowRegexes.some(re => new RegExp(re, "i").test(trimmed))) return "clean-feature";
	return null;
}

/** Diverged surfaces that make a feature unsuitable for automatic candidate generation. */
export function cleanFeatureBlockers(files: string[], policy: PortPolicy): DivergedSurface[] {
	return divergedMatches(files, policy).filter(surface => surface.blocksCleanFeatures !== false);
}
/** Whether a touched path is documentation rather than implementation surface. */
export function isDocumentationFile(file: string, policy: PortPolicy): boolean {
	const normalized = file.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (policy.documentationPaths.some(prefix => normalized.startsWith(prefix))) return true;
	const lower = normalized.toLowerCase();
	return policy.documentationExtensions.some(extension => lower.endsWith(extension.toLowerCase()));
}

/** A feature that changes only prose must not consume an implementation lane. */
export function isDocumentationOnly(files: string[], policy: PortPolicy): boolean {
	return files.length > 0 && files.every(file => isDocumentationFile(file, policy));
}

/** Final policy decision after a feature candidate's touched files are known. */
export function isPortWorthy(title: string, files: string[], policy: PortPolicy): boolean {
	const kind = portCandidateKind(title, policy);
	if (kind === "fix") return true;
	return (
		kind === "clean-feature" &&
		files.length > 0 &&
		!isDocumentationOnly(files, policy) &&
		cleanFeatureBlockers(files, policy).length === 0
	);
}

/** Diverged surfaces a PR's file list touches, by path prefix. */
export function divergedMatches(files: string[], policy: PortPolicy): DivergedSurface[] {
	return policy.divergedSurfaces.filter(s => s.paths.some(p => files.some(f => f.startsWith(p))));
}

/** The issue-body warning block for touched diverged surfaces, or "". */
export function divergenceWarning(surfaces: DivergedSurface[]): string {
	if (surfaces.length === 0) return "";
	const items = surfaces.map(s => `- **${s.name}**: ${s.note}`).join("\n");
	return `\n## Diverged surface warning\n\nThis change touches surfaces where veyyon deliberately went a different direction. veyyon's design wins:\n\n${items}\n`;
}

export interface GitHubPullFile {
	filename: string;
	additions: number;
	deletions: number;
}

/**
 * Validate the complete files response against GitHub's authoritative PR count.
 * GitHub caps this endpoint at 3,000 files, so a short response must fail loud
 * instead of screening and reporting a partial diff.
 */
export function completePullFiles(prNumber: number, expectedCount: number, records: unknown[]): GitHubPullFile[] {
	if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
		throw new Error(`upstream-radar: PR #${prNumber} returned invalid changed_files=${expectedCount}`);
	}
	if (records.length !== expectedCount) {
		throw new Error(
			`upstream-radar: PR #${prNumber} reports ${expectedCount} changed files, but GitHub returned ${records.length}; refusing partial triage`,
		);
	}
	return records.map((record, index) => {
		if (
			typeof record !== "object" ||
			record === null ||
			!("filename" in record) ||
			typeof record.filename !== "string" ||
			!("additions" in record) ||
			typeof record.additions !== "number" ||
			!("deletions" in record) ||
			typeof record.deletions !== "number"
		) {
			throw new Error(`upstream-radar: PR #${prNumber} returned an invalid file record at index ${index}`);
		}
		return { filename: record.filename, additions: record.additions, deletions: record.deletions };
	});
}

export interface PortIssueBrief {
	marker: string;
	kind: PortCandidateKind;
	url: string;
	mergedAt: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	warning: string;
	fileList: string;
	bodyExcerpt: string;
}

/** Render the evidence-only tracking issue that the manager embeds in Jules's prompt. */
export function renderPortIssue(brief: PortIssueBrief): string {
	return prompt.render(
		PORT_ISSUE_TEMPLATE,
		{
			...brief,
			isFeature: brief.kind === "clean-feature",
		},
		{ label: "scripts/upstream-port-issue.md" },
	);
}

/** Collect every page from a list endpoint without a silent item cap. */
export async function collectPages<T>(loadPage: (page: number) => Promise<T[]>): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; ; page++) {
		const batch = await loadPage(page);
		out.push(...batch);
		if (batch.length < 100) return out;
	}
}

async function gh(path: string, init?: RequestInit): Promise<any> {
	const res = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
	}
	return res.json();
}

/** Every page of a list endpoint; fails on any page error rather than returning a partial list. */
async function ghAll(path: string): Promise<any[]> {
	const sep = path.includes("?") ? "&" : "?";
	return collectPages(async page => {
		const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
		if (!Array.isArray(batch)) {
			throw new Error(`GitHub API GET ${path} returned a non-list response on page ${page}`);
		}
		return batch;
	});
}

async function ensureLabel(name: string, color: string, description: string): Promise<void> {
	const res = await fetch(`https://api.github.com/repos/${ORIGIN}/labels`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json" },
		body: JSON.stringify({ name, color, description }),
	});
	// 422 = already exists; anything else unexpected is fatal.
	if (!res.ok && res.status !== 422) {
		throw new Error(`creating label ${name} failed: ${res.status} ${await res.text()}`);
	}
}

interface PullEvidence {
	files: GitHubPullFile[];
	additions: number;
	deletions: number;
}

async function loadPullEvidence(prNumber: number): Promise<PullEvidence> {
	const detail = await gh(`/repos/${UPSTREAM}/pulls/${prNumber}`);
	if (
		typeof detail !== "object" ||
		detail === null ||
		typeof detail.changed_files !== "number" ||
		typeof detail.additions !== "number" ||
		typeof detail.deletions !== "number"
	) {
		throw new Error(`upstream-radar: PR #${prNumber} returned invalid summary counts`);
	}
	const records = await ghAll(`/repos/${UPSTREAM}/pulls/${prNumber}/files`);
	return {
		files: completePullFiles(prNumber, detail.changed_files, records),
		additions: detail.additions,
		deletions: detail.deletions,
	};
}

const marker = (n: number) => `<!-- upstream-pr: ${n} -->`;

if (import.meta.main) {
	if (!TOKEN) {
		console.error(
			"upstream-radar: GH_TOKEN/GITHUB_TOKEN is required (issues:write on the origin repo). Refusing to run unauthenticated.",
		);
		process.exit(1);
	}
	const policy = loadPolicy();
	const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

	// Recently-closed upstream PRs, newest first; keep only merged ones in window.
	const closed = await ghAll(`/repos/${UPSTREAM}/pulls?state=closed&sort=updated&direction=desc`);
	const inWindow = closed
		.filter(pr => pr.merged_at && Date.parse(pr.merged_at) >= cutoff)
		.sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at)); // oldest first: port in merge order
	const evidenceByPr = new Map<number, PullEvidence>();
	const merged: Array<{ pr: (typeof inWindow)[number]; kind: PortCandidateKind }> = [];
	for (const pr of inWindow) {
		const kind = portCandidateKind(pr.title, policy);
		if (kind === null) {
			console.log(`upstream-radar: skip (outside fix/clean-feature policy): #${pr.number} ${pr.title}`);
			continue;
		}
		const evidence = await loadPullEvidence(pr.number);
		evidenceByPr.set(pr.number, evidence);
		const filenames = evidence.files.map(file => file.filename);
		if (!isPortWorthy(pr.title, filenames, policy)) {
			if (isDocumentationOnly(filenames, policy)) {
				console.log(`upstream-radar: skip (documentation-only feature): #${pr.number} ${pr.title}`);
			} else {
				const blockers = cleanFeatureBlockers(filenames, policy);
				console.log(
					`upstream-radar: skip (feature crosses ${blockers.map(surface => surface.name).join(", ")}): #${pr.number} ${pr.title}`,
				);
			}
			continue;
		}
		merged.push({ pr, kind });
	}

	// Already-mirrored PR numbers, read from the marker in every issue we ever filed
	// (state=all so closing an issue never resurrects its PR).
	const existing = await ghAll(`/repos/${ORIGIN}/issues?labels=${PORT_LABEL}&state=all`);
	const seen = new Set<number>();
	for (const issue of existing) {
		const m = /^<!-- upstream-pr: (\d+) -->/.exec(issue.body ?? "");
		if (m) seen.add(Number(m[1]));
	}

	const fresh = merged.filter(({ pr }) => !seen.has(pr.number));
	console.log(
		`upstream-radar: ${merged.length} merged upstream PRs in the last ${LOOKBACK_DAYS}d, ${seen.size} already mirrored, ${fresh.length} new.`,
	);

	if (fresh.length === 0) process.exit(0);

	await ensureLabel(PORT_LABEL, "b06000", "Mirrored from a merged upstream oh-my-pi PR; awaiting port triage");
	await ensureLabel(AGENT_LABEL, "5319e7", "Assigned to the Jules async coding agent");

	const batch = fresh.slice(0, MAX_NEW_ISSUES_PER_RUN);
	if (batch.length < fresh.length) {
		// Loud cap, never a silent one: the remainder is picked up next run.
		console.log(
			`upstream-radar: capping at ${MAX_NEW_ISSUES_PER_RUN} new issues this run; ${fresh.length - batch.length} deferred to the next scheduled run.`,
		);
	}

	for (const { pr, kind } of batch) {
		const evidence = evidenceByPr.get(pr.number);
		if (!evidence) {
			throw new Error(`upstream-radar: PR #${pr.number} lost its validated file evidence`);
		}
		const fileList = evidence.files
			.map(file => `- \`${file.filename}\` (+${file.additions}/-${file.deletions})`)
			.join("\n");
		const filenames = evidence.files.map(file => file.filename);
		const warning = divergenceWarning(divergedMatches(filenames, policy));
		const bodyExcerpt = (pr.body ?? "").trim().slice(0, 3000);
		const body = renderPortIssue({
			marker: marker(pr.number),
			kind,
			url: pr.html_url,
			mergedAt: pr.merged_at,
			additions: evidence.additions,
			deletions: evidence.deletions,
			changedFiles: evidence.files.length,
			warning,
			fileList,
			bodyExcerpt: bodyExcerpt || "(no description)",
		});

		const issue = await gh(`/repos/${ORIGIN}/issues`, {
			method: "POST",
			body: JSON.stringify({
				title: `[upstream #${pr.number}] ${pr.title}`,
				body,
				labels: [PORT_LABEL, AGENT_LABEL],
			}),
		});
		console.log(`upstream-radar: filed #${issue.number} for upstream #${pr.number}: ${pr.title}`);
	}
}
