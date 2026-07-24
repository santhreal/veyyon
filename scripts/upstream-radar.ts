#!/usr/bin/env bun
/**
 * Upstream radar: mirror every newly MERGED oh-my-pi PR into one porting issue
 * on this repo, labeled for the Jules async coding agent to pick up.
 *
 * Why: veyyon forked can1357/oh-my-pi and has diverged (~500 commits), but
 * upstream ships real-world bug fixes at a pace veyyon cannot manually track
 * (30 releases in 3 days). Each merged upstream PR becomes an issue carrying
 * the diff surface and porting instructions; Jules (label trigger: `jules`)
 * evaluates applicability post-divergence and opens an adapted port PR, which
 * autoreview.yml and a human then gate. Dedup is by an HTML-comment marker
 * (`upstream-pr: <number>`) in the issue body, so re-runs are idempotent and
 * concurrent runs converge.
 *
 * Runs from .github/workflows/upstream-radar.yml on a schedule; also runnable
 * locally with GH_TOKEN set. Fails closed: any API error aborts the run with a
 * non-zero exit rather than silently skipping PRs.
 */

const UPSTREAM = "can1357/oh-my-pi";
const ORIGIN = process.env.GITHUB_REPOSITORY ?? "santhreal/veyyon";
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
// Operational knobs (Tier A): env overrides with safe defaults.
const LOOKBACK_DAYS = Number(process.env.RADAR_LOOKBACK_DAYS ?? "3");
const MAX_NEW_ISSUES_PER_RUN = Number(process.env.RADAR_MAX_ISSUES ?? "10");
const PORT_LABEL = "upstream-port";
const AGENT_LABEL = "jules";

if (!TOKEN) {
	console.error(
		"upstream-radar: GH_TOKEN/GITHUB_TOKEN is required (issues:write on the origin repo). Refusing to run unauthenticated.",
	);
	process.exit(1);
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
async function ghAll(path: string, cap = 1000): Promise<any[]> {
	const sep = path.includes("?") ? "&" : "?";
	const out: any[] = [];
	for (let page = 1; out.length < cap; page++) {
		const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
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

const marker = (n: number) => `<!-- upstream-pr: ${n} -->`;

const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

// Recently-closed upstream PRs, newest first; keep only merged ones in window.
const closed = await ghAll(`/repos/${UPSTREAM}/pulls?state=closed&sort=updated&direction=desc`, 300);
const merged = closed
	.filter(pr => pr.merged_at && Date.parse(pr.merged_at) >= cutoff)
	.sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at)); // oldest first: port in merge order

// Already-mirrored PR numbers, read from the marker in every issue we ever filed
// (state=all so closing an issue never resurrects its PR).
const existing = await ghAll(`/repos/${ORIGIN}/issues?labels=${PORT_LABEL}&state=all`, 2000);
const seen = new Set<number>();
for (const issue of existing) {
	const m = /<!-- upstream-pr: (\d+) -->/.exec(issue.body ?? "");
	if (m) seen.add(Number(m[1]));
}

const fresh = merged.filter(pr => !seen.has(pr.number));
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

for (const pr of batch) {
	const files = await ghAll(`/repos/${UPSTREAM}/pulls/${pr.number}/files`, 300);
	const fileList = files.map(f => `- \`${f.filename}\` (+${f.additions}/-${f.deletions})`).join("\n");
	const bodyExcerpt = (pr.body ?? "").trim().slice(0, 3000);

	const body = `${marker(pr.number)}
Upstream merged PR: ${pr.html_url} (merged ${pr.merged_at}, +${pr.additions}/-${pr.deletions} across ${pr.changed_files} files)

## Task: evaluate and port this upstream change to veyyon

veyyon is a diverged fork of oh-my-pi (see \`UPSTREAM.md\` for the provenance map). Port this change **adapted to veyyon**, not verbatim:

1. Read the upstream diff. Decide whether it still applies here: the touched subsystem may have been rewritten, renamed, or removed in veyyon. If it does not apply, comment on this issue explaining exactly why (which veyyon change supersedes it) and close the issue. Do not force a port.
2. If it applies, port it with veyyon's naming (\`omp\`→\`veyyon\`/\`vey\`, \`pi\` brand strings→\`vey\`, config dir \`.veyyon\`) and veyyon's architecture. Follow \`AGENTS.md\`.
3. Every behavior change lands with real-value regression tests in the existing suite structure (\`bun scripts/ci-test-ts.ts <suite>\`), and updates any user-facing docs that describe the behavior.
4. Open a PR titled \`port(upstream#${pr.number}): ${pr.title.replaceAll("`", "'")}\` referencing this issue.

## Upstream files touched

${fileList}

## Upstream PR description (excerpt)

${bodyExcerpt || "(no description)"}
`;

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
