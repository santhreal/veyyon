#!/usr/bin/env bun
/**
 * Jules port manager: drive every `upstream-port` issue through the Jules
 * async coding agent until it becomes a reviewed port PR.
 *
 * Why: scripts/upstream-radar.ts mirrors each merged oh-my-pi PR into one
 * issue labeled `upstream-port` + `jules`, on the assumption that the Jules
 * GitHub-app label trigger would pick issues up. It never did (140 open
 * issues, zero sessions, zero PRs). This manager replaces that assumption
 * with explicit Jules REST API dispatch, so the whole port pipeline is owned
 * by this repo and runs unattended: radar files issues, the manager turns
 * them into sessions, sessions turn into PRs, autoreview + a human gate the
 * merge, and the `Closes #N` line closes the issue.
 *
 * GitHub is the only state store. An issue's position in the pipeline is its
 * labels plus HTML-comment markers in its own comments; the manager keeps no
 * local files, so any machine with the keys can run any command idempotently
 * and concurrent runs converge:
 *
 *   upstream-port                    queued (filed by the radar)
 *   + jules-dispatched               a Jules session is in flight
 *   + port-pr-open                   the session opened a port PR; awaiting review
 *   + port-review                    session ended without a PR; needs a human look
 *   + port-blocked                   MAX_ATTEMPTS sessions failed; needs a human
 *
 * Markers (in issue comments):
 *   <!-- jules-session: sessions/<id> key:<fp8> -->   dispatch record; fp8 names
 *                                                     the API key (sha256 prefix,
 *                                                     never the key itself)
 *   <!-- jules-failed: sessions/<id> -->              one per failed attempt;
 *                                                     the count is the retry budget
 *   <!-- jules-nudged: sessions/<id> -->              one per autonomy answer sent
 *                                                     to a session that paused to
 *                                                     ask for input (cap MAX_NUDGES)
 *
 * Commands:
 *   tick      harvest then dispatch (the default; what cron runs)
 *   dispatch  create sessions for queued issues, oldest first
 *   harvest   poll in-flight sessions, advance labels, record failures
 *   status    pipeline counts + per-key budget table
 *   land      audit open port PRs, merge the clean ones into local main
 *
 * Landing is local-first, because this working tree is the canonical copy of
 * veyyon and GitHub is a mirror of it. `land` never presses the merge button:
 * it fetches each port PR, audits the files it touches against the
 * `neverPorted` policy, merges the clean ones into the local main with
 * `--no-ff`, and leaves pushing to you. Because the merge keeps each PR's head
 * commit, pushing that main is what marks the PR merged on GitHub, so the
 * mirror ends up correct without anyone merging there. A PR that fails the
 * audit is refused with the offending paths named and its issue routed to
 * port-review; nothing is ever partially applied.
 *
 * Keys: JULES_API_KEYS (comma-separated) wins; otherwise every `JULES_*=AQ.*`
 * line in JULES_ENV_FILE (default /credentials/.env) is a candidate key. Each
 * key is probed for access to the origin repo before use, so connecting more
 * Jules accounts to the repo scales capacity with zero config. Fails closed:
 * missing token, no usable key, or an API error exits non-zero and loud.
 */
import { readFileSync } from "node:fs";

const UPSTREAM = "can1357/oh-my-pi";
const ORIGIN = process.env.GITHUB_REPOSITORY ?? "santhreal/veyyon";
const JULES_API = "https://jules.googleapis.com/v1alpha";
const SOURCE = `sources/github/${ORIGIN}`;

// Operational knobs (Tier A): env overrides with safe defaults.
const MAX_DISPATCH_PER_RUN = Number(process.env.JULES_MAX_DISPATCH ?? "10");
const KEY_DAILY_BUDGET = Number(process.env.JULES_KEY_DAILY_BUDGET ?? "40");
const MAX_ATTEMPTS = Number(process.env.JULES_MAX_ATTEMPTS ?? "3");
const STALE_HOURS = Number(process.env.JULES_STALE_HOURS ?? "24");
const MAX_NUDGES = Number(process.env.JULES_MAX_NUDGES ?? "3");
const ENV_FILE = process.env.JULES_ENV_FILE ?? "/credentials/.env";
const WINDOW_HOURS = 24;
const HTTP_TIMEOUT_MS = 30_000;

// Resolved from this file, not the caller's cwd: `land` runs git in the repo
// it belongs to whether cron invokes it from / or you invoke it from a package.
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const POLICY_PATH = new URL("./upstream-port-policy.json", import.meta.url).pathname;

const QUEUE_LABEL = "upstream-port";
const DISPATCHED_LABEL = "jules-dispatched";
const PR_OPEN_LABEL = "port-pr-open";
const REVIEW_LABEL = "port-review";
const BLOCKED_LABEL = "port-blocked";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in jules-port-manager.test.ts).

/**
 * Every `JULES_*=AQ.*` credential in an env file body, in file order, deduped by
 * key, carrying the variable name that declared it.
 *
 * The name is the only human-readable identity a key has. A lane that cannot
 * see the repo needs the Jules GitHub app granted on one specific account, and
 * "lane 40600b58" (a sha256 prefix) does not tell anyone which account that is,
 * whereas `JULES_TT_MACBOOK_PRO` does. The name is safe to print; the key
 * never is, which is why the fingerprint exists at all.
 *
 * Deduping is by key, not by name: the same credential under two names is one
 * lane, and the first name wins.
 */
export interface JulesKey {
	/** The env variable that declared it, e.g. `JULES_TT_MACBOOK_PRO`. */
	name: string;
	key: string;
}

export function parseEnvKeys(envText: string): JulesKey[] {
	const keys: JulesKey[] = [];
	for (const line of envText.split("\n")) {
		const m = /^(JULES_[A-Z0-9_]+)=(AQ\.\S+)\s*$/.exec(line.trim());
		if (m && !keys.some(k => k.key === m[2])) keys.push({ name: m[1], key: m[2] });
	}
	return keys;
}

/** Non-secret name for a key: first 8 hex chars of its sha256. */
export function keyFingerprint(key: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(key);
	return hasher.digest("hex").slice(0, 8);
}

export const sessionMarker = (session: string, fp: string) => `<!-- jules-session: ${session} key:${fp} -->`;
export const failMarker = (session: string) => `<!-- jules-failed: ${session} -->`;

/** Latest dispatch record in an issue's comments, or null if never dispatched. */
export function latestSessionMarker(commentBodies: string[]): { session: string; fp: string } | null {
	let found: { session: string; fp: string } | null = null;
	for (const body of commentBodies) {
		const m = /<!-- jules-session: (sessions\/\S+) key:([0-9a-f]{8}) -->/.exec(body);
		if (m) found = { session: m[1], fp: m[2] };
	}
	return found;
}

/** Failed-attempt count: one jules-failed marker is appended per dead session. */
export function countFailures(commentBodies: string[]): number {
	return commentBodies.filter(b => /<!-- jules-failed: sessions\/\S+ -->/.test(b)).length;
}

export const nudgeMarker = (session: string) => `<!-- jules-nudged: ${session} -->`;

/** Nudges already sent to ONE session (retry sessions restart the budget). */
export function countNudges(commentBodies: string[], session: string): number {
	const marker = nudgeMarker(session);
	return commentBodies.filter(b => b.includes(marker)).length;
}

/** The autonomy answer sent to a session that paused to ask permission. */
export const NUDGE_PROMPT =
	"Proceed autonomously; you will get no further human input. Make the decision you judge best, run the tests, finish the port, and open the PR with the mandated Closes line. If the change truly does not apply, end the session with a NOT-APPLICABLE summary. Do not pause to ask again.";

/** The mirrored upstream PR number from the radar's marker, or null. */
export function upstreamNumberFromIssue(issueBody: string): number | null {
	const m = /<!-- upstream-pr: (\d+) -->/.exec(issueBody);
	return m ? Number(m[1]) : null;
}

/**
 * The session prompt. The radar already wrote the issue body as a complete
 * porting brief; the manager adds only what Jules cannot know: which issue
 * this is (so `Closes #N` wires the PR to it) and the previous attempt's
 * failure context, if any, so a retry does not repeat the same dead end.
 */
export function buildPortPrompt(issueNumber: number, issueBody: string, priorFailure: string | null): string {
	const retry =
		priorFailure === null
			? ""
			: `\n## Previous attempt failed\n\nA prior session on this task did not produce a PR. Its recorded failure state was:\n\n${priorFailure.slice(0, 2000)}\n\nRead it, avoid the same dead end, and take a different approach where it points at one.\n`;
	return `You are working on ${ORIGIN}, branch main. This task is GitHub issue #${issueNumber}.

${issueBody}
${retry}
## PR requirements (mandatory)

- The PR body MUST contain the exact line \`Closes #${issueNumber}\` so the merge closes the tracking issue.
- Branch from current \`origin/main\` and NEVER merge \`main\` into your branch. If your clone has gone stale, fetch and rebase; a merge you resolve in your own favour silently reverts commits that landed while you worked, and such a PR is rejected on sight however good the fix is.
- Your diff must contain the fix and nothing else. Before committing, run \`git status\` and \`git diff --stat\`, and confirm every path is one you deliberately changed for this fix. A one-file fix has a one-file diff. If \`git diff --stat\` shows dozens of files you did not intend, your branch is stale: start over from a fresh \`origin/main\` rather than committing it.
- Never commit: lockfiles (\`bun.lock\`, \`Cargo.lock\`), \`.gitignore\`, workflow files under \`.github/\`, anything under \`docs/handbook/book/\` or \`docs/internal/\`, or the port pipeline's own \`scripts/upstream-*\` and \`scripts/jules-port-manager*\`. Those belong to veyyon, not to any port. If a build step rewrites one of them, \`git checkout -- <path>\` it before you commit.
- Delete every scratch file you created before committing: \`patch_*.ts\`, \`test_*.ts\`, debug scripts, downloaded \`*.diff\`/\`*.patch\` files, notes, tool output. They must not appear in \`git status\`.
- A user-facing change gets one bullet under \`## [Unreleased]\` in the touched package's CHANGELOG.md. If you touch \`packages/coding-agent/CHANGELOG.md\`, run \`bun scripts/sync-root-changelog.ts\` and commit the regenerated root \`CHANGELOG.md\` too (CI's "Changelog entry" check enforces the pair). Do NOT edit \`docs/handbook/src/\`: porting a bug fix never needs a handbook change, and rebuilding the book drags hundreds of generated files into your diff.
- Keep existing tests. Add your cases to the test file that already covers the code you changed; never rewrite or shrink that file around your new behaviour. A port that removes more test lines than it adds is rejected even when its fix is correct.
- veyyon's product direction wins over upstream's. Where veyyon diverged (its own model catalog with its own model IDs, types, and roles; its own branding, install flow, and docs), port the underlying bug onto veyyon's design; never import upstream's scheme. The issue's "Diverged surface warning" section, when present, is binding.
- If the change does NOT apply to veyyon (superseded, subsystem rewritten or removed), commit nothing. End the session with a summary starting with \`NOT-APPLICABLE:\` naming the veyyon change that supersedes it; if your mode forces a PR anyway, keep its diff EMPTY and title it \`NOT-APPLICABLE: <original title>\` with the reasoning and the \`Closes #${issueNumber}\` line in the body.
`;
}

export interface PortPrRef {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state?: string;
	merged_at?: string | null;
}

export type PathRules = { prefixes: string[]; exact: string[]; regexes: string[] };
export type NeverPortedPolicy = { refuseThreshold: number; owned: PathRules; quarantine: PathRules };

/**
 * The `neverPorted` block of scripts/upstream-port-policy.json, which names
 * the paths no port PR may carry. Parsed rather than hardcoded so the lists
 * have one owner shared with the radar's policy, and fails closed: a policy
 * file that has lost a tier would otherwise make every audit pass.
 */
export function parseNeverPorted(policyText: string): NeverPortedPolicy {
	const block = JSON.parse(policyText)?.neverPorted;
	if (!block || typeof block !== "object")
		throw new Error("upstream-port-policy.json: missing the neverPorted block that `land` audits against");
	const rules = (tier: unknown, name: string): PathRules => {
		if (!tier || typeof tier !== "object")
			throw new Error(`upstream-port-policy.json: neverPorted.${name} must be an object of path rules`);
		const t = tier as Record<string, unknown>;
		const list = (v: unknown, field: string): string[] => {
			if (!Array.isArray(v) || v.some(x => typeof x !== "string"))
				throw new Error(`upstream-port-policy.json: neverPorted.${name}.${field} must be an array of strings`);
			return v as string[];
		};
		return {
			prefixes: list(t.prefixes, "prefixes"),
			exact: list(t.exact, "exact"),
			regexes: list(t.regexes, "regexes"),
		};
	};
	const threshold = block.refuseThreshold;
	if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1)
		throw new Error("upstream-port-policy.json: neverPorted.refuseThreshold must be an integer >= 1");
	return {
		refuseThreshold: threshold,
		owned: rules(block.owned, "owned"),
		quarantine: rules(block.quarantine, "quarantine"),
	};
}

const matchesRules = (file: string, rules: PathRules): boolean =>
	rules.prefixes.some(p => file.startsWith(p)) ||
	rules.exact.includes(file) ||
	rules.regexes.some(r => new RegExp(r).test(file));

export type TestDelta = { path: string; added: number; removed: number };

/**
 * Test files a port PR shrinks, worst first. Empty means no coverage was lost.
 *
 * A port is only real when it arrives with a test, so a port that removes more
 * test lines than it adds has done the opposite of its job. The pipeline
 * produces this on its own: PR #203 carried a genuinely good six-line fix
 * capping tool timeouts with the global ceiling, and rewrote the suite guarding
 * it from 296 lines down to 24, dropping every exact-value assertion plus all
 * coverage of formatTimeoutClampNotice and describeTimeoutParam while both
 * functions stayed in the source. Nothing failed and no path rule fired: the
 * suite still passed, smaller. Line counts are a blunt instrument, so this only
 * reports net shrinkage of a file already recognised as a test, which a
 * legitimate port never does.
 */
export function testFilesShrunk(deltas: TestDelta[]): TestDelta[] {
	return deltas
		.filter(d => /(?:^|\/)(?:test|tests|__tests__)\//.test(d.path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(d.path))
		.filter(d => d.removed > d.added)
		.sort((a, b) => b.removed - b.added - (a.removed - a.added));
}

export type PortAudit = { refuse: string[]; quarantine: string[] };

/**
 * Decide what to do with a port PR's changed files: refuse the whole diff, or
 * land it with some paths quarantined. Both lists keep the order given.
 *
 * This is the whole defence against the pipeline's worst failure mode. A Jules
 * session works from a clone that goes stale while it runs; when it reconciles
 * by merging main and resolving in its own favour, or simply branches from an
 * old base, the resulting PR quietly REVERSES commits already on main. That is
 * invisible in the title and nearly invisible in review: #184 was titled a
 * one-file IME composition fix and its diff reverted the port manager, the
 * radar, four workflows and 180 rendered handbook pages.
 *
 * Bulk is what separates a revert from drift, so the owned-path count is the
 * detector. Under the threshold the hits are drift around a real fix (#196
 * refreshed one docs/internal freshness stamp) and get quarantined with the
 * rest of the noise. At or above it the branch is reverting main wholesale, and
 * the whole PR is refused rather than filtered: a diff that stale also reverts
 * ordinary source files that no path list can recognise, so its remaining
 * changes cannot be trusted either.
 */
export function auditPortFiles(files: string[], policy: NeverPortedPolicy): PortAudit {
	const owned = files.filter(f => matchesRules(f, policy.owned));
	if (owned.length >= policy.refuseThreshold) return { refuse: owned, quarantine: [] };
	const noise = files.filter(f => matchesRules(f, policy.quarantine));
	return { refuse: [], quarantine: files.filter(f => owned.includes(f) || noise.includes(f)) };
}

/**
 * The port PR for an issue among a PR list. Three signals, each intentional:
 * a closing keyword + `#N` (the prompt mandates `Closes #N`), the radar's
 * `port(upstream#M)` title prefix, or a bare `#N` ONLY inside a PR that
 * Jules itself authored (its auto-footer). A bare `#N` in an arbitrary PR
 * body is NOT a signal: dependabot bodies quote changelogs full of other
 * repos' `#numbers`, and one collision would mark a port done that never
 * landed. Word-boundary match so #16 never claims #167's PR.
 */
export function findPortPr<T extends PortPrRef>(
	prs: T[],
	issueNumber: number,
	upstreamNumber: number | null,
): T | null {
	const closes = new RegExp(`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
	const bare = new RegExp(`#${issueNumber}\\b`);
	const julesFooter = /PR created automatically by Jules/i;
	for (const pr of prs) {
		const body = pr.body ?? "";
		if (closes.test(body)) return pr;
		if (upstreamNumber !== null && pr.title.includes(`port(upstream#${upstreamNumber})`)) return pr;
		if (julesFooter.test(body) && bare.test(body)) return pr;
	}
	return null;
}

export type PrOpenAction =
	| { kind: "keep" }
	| { kind: "requeue"; reason: string }
	| { kind: "close"; reason: string }
	| { kind: "review"; reason: string };

/**
 * What harvest does with an issue already marked port-pr-open. Without this
 * pass a port PR closed WITHOUT merging strands its issue in pr-open forever
 * (the pipeline never revisits it), and a merged PR whose Closes line was
 * mangled leaves a done issue open, polluting every queue count.
 *
 * A NOT-APPLICABLE PR is a verdict, not a port: Jules's AUTO_CREATE_PR mode
 * always opens a PR at completion, so "does not apply" arrives as an empty
 * PR titled `NOT-APPLICABLE: ...` (seen live on the first day). That issue
 * goes to port-review for verification; closing such a PR unmerged must
 * never requeue the port, or every confirmed non-applicable change would be
 * re-attempted forever.
 */
export function classifyPrOpen(pr: PortPrRef | null): PrOpenAction {
	if (pr === null) return { kind: "review", reason: "labeled port-pr-open but no PR references this issue" };
	if (/^\s*NOT-APPLICABLE\b/i.test(pr.title) || /^\s*NOT-APPLICABLE\b/im.test(pr.body ?? ""))
		return {
			kind: "review",
			reason: `PR #${pr.number} is a NOT-APPLICABLE verdict, not a port; verify its reasoning, then close both PR and issue`,
		};
	if (pr.merged_at) return { kind: "close", reason: `port PR #${pr.number} merged` };
	if ((pr.state ?? "open") === "closed")
		return { kind: "requeue", reason: `port PR #${pr.number} was closed without merging` };
	return { kind: "keep" };
}

/** Sessions created inside the rolling window, given a newest-first list. */
export function countRecentSessions(createTimes: string[], nowMs: number, windowHours: number): number {
	const cutoff = nowMs - windowHours * 3600_000;
	let used = 0;
	for (const t of createTimes) {
		const ms = Date.parse(t);
		if (Number.isNaN(ms)) continue; // unparseable never inflates usage
		if (ms >= cutoff) used++;
	}
	return used;
}

/** Any origin pull-request URL anywhere in a session resource, schema-agnostic. */
export function extractPrUrl(sessionJson: unknown): string | null {
	const m = new RegExp(`https://github\\.com/${ORIGIN}/pull/\\d+`).exec(JSON.stringify(sessionJson));
	return m ? m[0] : null;
}

export type HarvestAction =
	| { kind: "pr-open"; url: string }
	| { kind: "review"; reason: string }
	| { kind: "failed"; reason: string }
	| { kind: "nudge" }
	| { kind: "wait" };

/**
 * What harvest does with one in-flight session. A PR wins over any state
 * (the artifact exists, whatever the session says). Terminal failure states
 * retry via the failure budget. Jules mid-run pauses in AWAITING_USER_FEEDBACK
 * to ask "should I proceed?"; an unattended pipeline answers those itself
 * (nudge, bounded by MAX_NUDGES so an agent looping on questions eventually
 * reaches a human). COMPLETED with no PR, or a session still asking after the
 * nudge budget past the stale window, goes to a human: retrying an identical
 * prompt against an agent that finished or is asking a question only burns
 * quota. A session silently in-flight past the stale window is treated as
 * dead and retried.
 */
export function classifyHarvest(
	state: string,
	prUrl: string | null,
	ageHours: number,
	staleHours: number,
	nudges = 0,
	maxNudges = MAX_NUDGES,
): HarvestAction {
	if (prUrl) return { kind: "pr-open", url: prUrl };
	const s = state.toUpperCase();
	if (["FAILED", "ERROR", "CANCELLED"].includes(s)) return { kind: "failed", reason: `session state ${s}` };
	if (s === "COMPLETED") return { kind: "review", reason: "session COMPLETED without opening a PR" };
	if (s === "AWAITING_USER_FEEDBACK" && nudges < maxNudges) return { kind: "nudge" };
	if (ageHours > staleHours) {
		if (s === "AWAITING_USER_FEEDBACK")
			return {
				kind: "review",
				reason: `session stuck in ${s} for ${Math.round(ageHours)}h after ${nudges} nudges; it needs a real answer, not a retry`,
			};
		return { kind: "failed", reason: `session stale: ${s} for ${Math.round(ageHours)}h with no PR` };
	}
	return { kind: "wait" };
}

// ---------------------------------------------------------------------------
// HTTP plumbing. Fails closed: any non-OK response throws.

function ghToken(): string {
	const t = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (t) return t;
	const proc = Bun.spawnSync(["gh", "auth", "token"]);
	const out = proc.stdout?.toString().trim();
	if (proc.exitCode === 0 && out) return out;
	throw new Error(
		"jules-port-manager: no GH_TOKEN/GITHUB_TOKEN and `gh auth token` failed. Refusing to run unauthenticated.",
	);
}

async function gh(path: string, init?: RequestInit): Promise<any> {
	const res = await fetch(`https://api.github.com${path}`, {
		...init,
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		headers: {
			authorization: `Bearer ${TOKEN}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok)
		throw new Error(`GitHub API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
	if (res.status === 204) return null;
	return res.json();
}

/** Every page of a list endpoint; fails on any page error, never partial. */
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

async function jules(key: string, path: string, init?: RequestInit): Promise<any> {
	const res = await fetch(`${JULES_API}${path}`, {
		...init,
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		headers: { "X-Goog-Api-Key": key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok)
		throw new Error(
			`Jules API ${init?.method ?? "GET"} ${path} failed: ${res.status} ${(await res.text()).slice(0, 400)}`,
		);
	return res.json();
}

/** The session's last agent-authored message, or null. Review-path only. */
async function lastAgentMessage(key: string, sessionName: string): Promise<string | null> {
	let last: string | null = null;
	let pageToken = "";
	for (let page = 0; page < 50; page++) {
		const d = await jules(
			key,
			`/${sessionName}/activities?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`,
		);
		for (const a of d.activities ?? []) {
			const msg = a?.agentMessaged?.agentMessage;
			if (typeof msg === "string" && msg.trim()) last = msg;
		}
		pageToken = d.nextPageToken ?? "";
		if (!pageToken) break;
	}
	return last;
}

// ---------------------------------------------------------------------------
// Key discovery and per-key budget.

interface Lane {
	/** The env variable that declared the key, for operator-facing messages. */
	name: string;
	key: string;
	fp: string;
	remaining: number;
}

function resolveKeys(): JulesKey[] {
	const inline = process.env.JULES_API_KEYS;
	// An inline list carries no names, so each entry is identified by position.
	// That is still better than a hash: "JULES_API_KEYS[2]" tells you which entry
	// of your own variable to fix.
	if (inline)
		return inline
			.split(",")
			.map(k => k.trim())
			.filter(Boolean)
			.map((key, index) => ({ name: `JULES_API_KEYS[${index}]`, key }));
	let text: string;
	try {
		text = readFileSync(ENV_FILE, "utf8");
	} catch {
		throw new Error(`jules-port-manager: JULES_API_KEYS unset and ${ENV_FILE} unreadable. No Jules keys available.`);
	}
	return parseEnvKeys(text);
}

/** Keys that can see the origin repo, with their remaining 24h session budget. */
async function usableLanes(keys: JulesKey[]): Promise<Lane[]> {
	const lanes: Lane[] = [];
	for (const { name, key } of keys) {
		const fp = keyFingerprint(key);
		try {
			await jules(key, `/${SOURCE}`);
		} catch {
			// Name the account and the fix. This is the pipeline's most common
			// stall and the operator can do nothing about "lane 40600b58".
			console.log(
				`lane ${name} (${fp}): cannot see ${ORIGIN}. Grant the Jules GitHub app on that account at ` +
					`https://jules.google.com/settings, give it access to ${ORIGIN}, then re-run. Skipping.`,
			);
			continue;
		}
		// Session list is newest-first; stop paginating once a page's oldest
		// entry falls outside the window.
		const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
		const times: string[] = [];
		let pageToken = "";
		for (let page = 0; page < 50; page++) {
			const d = await jules(key, `/sessions?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
			const sessions: any[] = d.sessions ?? [];
			for (const s of sessions) times.push(s.createTime ?? "");
			const oldest = sessions.at(-1)?.createTime;
			pageToken = d.nextPageToken ?? "";
			if (!pageToken || (oldest && Date.parse(oldest) < cutoff)) break;
		}
		const used = countRecentSessions(times, Date.now(), WINDOW_HOURS);
		const remaining = Math.max(0, KEY_DAILY_BUDGET - used);
		lanes.push({ name, key, fp, remaining });
		console.log(
			`lane ${name} (${fp}): ${used} sessions in the last ${WINDOW_HOURS}h, ${remaining}/${KEY_DAILY_BUDGET} budget left.`,
		);
	}
	return lanes;
}

// ---------------------------------------------------------------------------
// Labels.

async function ensureLabel(name: string, color: string, description: string): Promise<void> {
	const res = await fetch(`https://api.github.com/repos/${ORIGIN}/labels`, {
		method: "POST",
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json" },
		body: JSON.stringify({ name, color, description }),
	});
	// 422 = already exists; anything else unexpected is fatal.
	if (!res.ok && res.status !== 422)
		throw new Error(`creating label ${name} failed: ${res.status} ${await res.text()}`);
}

async function ensurePipelineLabels(): Promise<void> {
	await ensureLabel(DISPATCHED_LABEL, "1d76db", "A Jules session is in flight for this port issue");
	await ensureLabel(PR_OPEN_LABEL, "0e8a16", "Jules opened a port PR; awaiting review");
	await ensureLabel(REVIEW_LABEL, "fbca04", "Jules session ended without a PR; needs a human look");
	await ensureLabel(BLOCKED_LABEL, "d93f0b", "Port attempts exhausted; needs a human");
}

const hasLabel = (issue: any, name: string) => (issue.labels ?? []).some((l: any) => l.name === name);
const addLabels = (n: number, labels: string[]) =>
	gh(`/repos/${ORIGIN}/issues/${n}/labels`, { method: "POST", body: JSON.stringify({ labels }) });
const removeLabel = (n: number, label: string) =>
	gh(`/repos/${ORIGIN}/issues/${n}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }).catch((e: Error) => {
		// Removing an already-absent label is the goal state, not an error.
		if (!/404/.test(e.message)) throw e;
	});
const comment = (n: number, body: string) =>
	gh(`/repos/${ORIGIN}/issues/${n}/comments`, { method: "POST", body: JSON.stringify({ body }) });
const issueComments = async (n: number): Promise<string[]> =>
	(await ghAll(`/repos/${ORIGIN}/issues/${n}/comments`, 300)).map((c: any) => c.body ?? "");

// ---------------------------------------------------------------------------
// dispatch: queued issues -> Jules sessions, oldest first.

async function dispatch(): Promise<void> {
	await ensurePipelineLabels();
	const lanes = await usableLanes(resolveKeys());
	const capacity = lanes.reduce((s, l) => s + l.remaining, 0);
	if (capacity === 0) {
		console.log("dispatch: no lane has budget or repo access; nothing dispatched.");
		return;
	}

	const open = await ghAll(
		`/repos/${ORIGIN}/issues?labels=${QUEUE_LABEL}&state=open&sort=created&direction=asc`,
		2000,
	);
	const queued = open.filter(
		i =>
			!i.pull_request &&
			!hasLabel(i, DISPATCHED_LABEL) &&
			!hasLabel(i, PR_OPEN_LABEL) &&
			!hasLabel(i, REVIEW_LABEL) &&
			!hasLabel(i, BLOCKED_LABEL),
	);
	console.log(`dispatch: ${queued.length} queued issues, capacity ${capacity}, per-run cap ${MAX_DISPATCH_PER_RUN}.`);

	let laneIdx = 0;
	let dispatched = 0;
	for (const issue of queued) {
		if (dispatched >= MAX_DISPATCH_PER_RUN) {
			// Loud cap, never a silent one: the remainder is next run's work.
			console.log(
				`dispatch: per-run cap ${MAX_DISPATCH_PER_RUN} reached; ${queued.length - dispatched} issues left for the next run.`,
			);
			break;
		}
		const comments = await issueComments(issue.number);
		const failures = countFailures(comments);
		if (failures >= MAX_ATTEMPTS) {
			await addLabels(issue.number, [BLOCKED_LABEL]);
			await comment(
				issue.number,
				`${failures} Jules sessions failed on this port; blocking it for a human. Remove the \`${BLOCKED_LABEL}\` label (and the failure comments' weight, by closing/reopening intent) after resolving.`,
			);
			console.log(`dispatch: #${issue.number} blocked after ${failures} failed attempts.`);
			continue;
		}
		// Round-robin across lanes with budget left.
		let lane: Lane | null = null;
		for (let i = 0; i < lanes.length; i++) {
			const cand = lanes[(laneIdx + i) % lanes.length];
			if (cand.remaining > 0) {
				lane = cand;
				laneIdx = (laneIdx + i + 1) % lanes.length;
				break;
			}
		}
		if (!lane) {
			console.log("dispatch: all lane budgets exhausted; stopping.");
			break;
		}
		const priorFailure = failures > 0 ? (comments.filter(b => /<!-- jules-failed: /.test(b)).at(-1) ?? null) : null;
		const prompt = buildPortPrompt(issue.number, issue.body ?? "", priorFailure);
		const session = await jules(lane.key, "/sessions", {
			method: "POST",
			body: JSON.stringify({
				prompt,
				sourceContext: { source: SOURCE, githubRepoContext: { startingBranch: "main" } },
				automationMode: "AUTO_CREATE_PR",
				title: `port #${issue.number}: ${issue.title}`.slice(0, 200),
			}),
		});
		const name: string = session.name ?? `sessions/${session.id}`;
		lane.remaining--;
		dispatched++;
		await addLabels(issue.number, [DISPATCHED_LABEL]);
		await comment(
			issue.number,
			`${sessionMarker(name, lane.fp)}\nDispatched Jules session [\`${name}\`](${session.url ?? `https://jules.google.com/session/${session.id}`}) (attempt ${failures + 1}/${MAX_ATTEMPTS}).`,
		);
		console.log(`dispatch: #${issue.number} -> ${name} on lane ${lane.fp} (attempt ${failures + 1}).`);
	}
	console.log(`dispatch: ${dispatched} sessions created.`);
}

// ---------------------------------------------------------------------------
// harvest: in-flight sessions -> pr-open / review / failed / keep waiting.

async function harvest(): Promise<void> {
	const inflight = (await ghAll(`/repos/${ORIGIN}/issues?labels=${DISPATCHED_LABEL}&state=open`, 2000)).filter(
		i => !i.pull_request,
	);
	const prOpen = (await ghAll(`/repos/${ORIGIN}/issues?labels=${PR_OPEN_LABEL}&state=open`, 2000)).filter(
		i => !i.pull_request && !hasLabel(i, DISPATCHED_LABEL),
	);
	if (inflight.length === 0 && prOpen.length === 0) {
		console.log("harvest: nothing in flight.");
		return;
	}
	// `resolveKeys` yields `{ name, key }`, not a bare key. Taking the whole object
	// as `key` fingerprinted an object (so `marker.fp` matched no lane and the
	// preferred-lane sort below was a no-op) and then passed that object to `jules`
	// as the API credential, which no lane could authenticate. Nothing caught it
	// because `scripts/` was not typechecked.
	const lanes = resolveKeys().map(({ name, key }) => ({ name, key, fp: keyFingerprint(key) }));
	// One PR listing serves every issue this run.
	const prs = await ghAll(`/repos/${ORIGIN}/pulls?state=all&sort=created&direction=desc`, 300);

	// Phase 1 — issues whose port PR is out for review: notice merges (close
	// the issue if the Closes line failed to) and rejections (requeue).
	if (prOpen.length > 0) console.log(`harvest: ${prOpen.length} port PRs out for review.`);
	for (const issue of prOpen) {
		const pr = findPortPr(prs, issue.number, upstreamNumberFromIssue(issue.body ?? ""));
		const action = classifyPrOpen(pr);
		switch (action.kind) {
			case "keep":
				break;
			case "close":
				await comment(issue.number, `${action.reason}; closing.`);
				await gh(`/repos/${ORIGIN}/issues/${issue.number}`, {
					method: "PATCH",
					body: JSON.stringify({ state: "closed" }),
				});
				console.log(`harvest: #${issue.number} closed (${action.reason}).`);
				break;
			case "requeue":
				await comment(
					issue.number,
					`${failMarker(`sessions/pr-${pr?.number}`)}\n${action.reason}; requeued (attempt budget ${MAX_ATTEMPTS}).`,
				);
				await removeLabel(issue.number, PR_OPEN_LABEL);
				console.log(`harvest: #${issue.number} requeued (${action.reason}).`);
				break;
			case "review":
				await addLabels(issue.number, [REVIEW_LABEL]);
				await removeLabel(issue.number, PR_OPEN_LABEL);
				await comment(issue.number, `Needs a human: ${action.reason}.`);
				console.log(`harvest: #${issue.number} -> ${REVIEW_LABEL} (${action.reason}).`);
				break;
		}
	}

	if (inflight.length === 0) return;
	console.log(`harvest: ${inflight.length} sessions in flight.`);

	for (const issue of inflight) {
		const comments = await issueComments(issue.number);
		const marker = latestSessionMarker(comments);
		if (!marker) {
			// Label without a marker: a crashed dispatch. Surface, unblock, retry.
			await removeLabel(issue.number, DISPATCHED_LABEL);
			await comment(
				issue.number,
				`${failMarker("sessions/unknown")}\n\`${DISPATCHED_LABEL}\` was set but no session marker exists (dispatch crashed mid-write). Requeued.`,
			);
			console.error(`harvest: #${issue.number} had the label but no session marker; requeued.`);
			continue;
		}
		const laneOrder = [...lanes].sort((a, b) => (a.fp === marker.fp ? -1 : b.fp === marker.fp ? 1 : 0));
		let session: any = null;
		let sessionKey = "";
		let lastErr = "";
		for (const lane of laneOrder) {
			try {
				session = await jules(lane.key, `/${marker.session}`);
				sessionKey = lane.key;
				break;
			} catch (e) {
				lastErr = String(e);
			}
		}
		if (!session) {
			// A session no key can see is dead to the pipeline: record and retry.
			await comment(
				issue.number,
				`${failMarker(marker.session)}\nSession \`${marker.session}\` is unreachable from every configured key: ${lastErr.slice(0, 300)}. Requeued.`,
			);
			await removeLabel(issue.number, DISPATCHED_LABEL);
			console.error(`harvest: #${issue.number} session ${marker.session} unreachable; requeued.`);
			continue;
		}

		const prUrl =
			extractPrUrl(session) ??
			findPortPr(prs, issue.number, upstreamNumberFromIssue(issue.body ?? ""))?.html_url ??
			null;
		const ageHours = (Date.now() - Date.parse(session.createTime ?? "")) / 3600_000;
		const nudges = countNudges(comments, marker.session);
		const action = classifyHarvest(
			session.state ?? "",
			prUrl,
			Number.isNaN(ageHours) ? 0 : ageHours,
			STALE_HOURS,
			nudges,
		);

		switch (action.kind) {
			case "pr-open":
				await addLabels(issue.number, [PR_OPEN_LABEL]);
				await removeLabel(issue.number, DISPATCHED_LABEL);
				await comment(
					issue.number,
					`Port PR opened by Jules: ${action.url}. Autoreview and a human gate the merge; merging closes this issue.`,
				);
				console.log(`harvest: #${issue.number} -> PR ${action.url}.`);
				break;
			case "review": {
				await addLabels(issue.number, [REVIEW_LABEL]);
				await removeLabel(issue.number, DISPATCHED_LABEL);
				// Quote the session's final word so triage never needs session
				// spelunking: for a NOT-APPLICABLE verdict the reasoning to
				// verify is right on the issue.
				const finalWord = await lastAgentMessage(sessionKey, marker.session).catch(() => null);
				const quoted = finalWord
					? `\n\nSession's final message:\n\n> ${finalWord.slice(0, 1500).replaceAll("\n", "\n> ")}`
					: "";
				await comment(
					issue.number,
					`Session [\`${marker.session}\`](${session.url ?? ""}) needs a human: ${action.reason}. If it declared NOT-APPLICABLE, verify the reasoning and close this issue; otherwise resolve and remove \`${REVIEW_LABEL}\` to requeue.${quoted}`,
				);
				console.log(`harvest: #${issue.number} -> ${REVIEW_LABEL} (${action.reason}).`);
				break;
			}
			case "failed":
				await comment(
					issue.number,
					`${failMarker(marker.session)}\nSession [\`${marker.session}\`](${session.url ?? ""}) failed: ${action.reason}. Requeued (attempt budget ${MAX_ATTEMPTS}).`,
				);
				await removeLabel(issue.number, DISPATCHED_LABEL);
				console.log(`harvest: #${issue.number} failed (${action.reason}); requeued.`);
				break;
			case "nudge":
				await jules(sessionKey, `/${marker.session}:sendMessage`, {
					method: "POST",
					body: JSON.stringify({ prompt: NUDGE_PROMPT }),
				});
				await comment(
					issue.number,
					`${nudgeMarker(marker.session)}\nSession paused to ask for input; answered with the autonomy nudge (${nudges + 1}/${MAX_NUDGES}).`,
				);
				console.log(`harvest: #${issue.number} nudged (${nudges + 1}/${MAX_NUDGES}).`);
				break;
			case "wait":
				console.log(`harvest: #${issue.number} still running (${session.state}, ${Math.round(ageHours)}h).`);
				break;
		}
	}
}

// ---------------------------------------------------------------------------
// land: audited local merges. This tree is canonical; GitHub mirrors it.

/** Run git in the repo root; throws with git's own stderr on failure. */
function git(...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT });
	if (proc.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${proc.stderr?.toString().trim()}`);
	return proc.stdout?.toString().trim() ?? "";
}

/** git that reports failure instead of throwing, for probes and merge attempts. */
function gitTry(...args: string[]): { ok: boolean; out: string } {
	const proc = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT });
	return {
		ok: proc.exitCode === 0,
		out: `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim(),
	};
}

/**
 * Refuse to land unless main can absorb a merge without touching work in
 * progress. Two things are genuinely unsafe and both fail closed here.
 *
 * A merge onto a detached head or a feature branch puts ports somewhere nobody
 * will push. And a staged-but-uncommitted index is swept into the merge commit
 * wholesale, because the commit that closes a merge takes whatever the index
 * holds, so someone else's half-staged edit would ship inside a port.
 *
 * An unstaged dirty tree is NOT refused, because doing so would make `land`
 * unrunnable here: this repo's main tree is the canonical copy and carries
 * in-progress work essentially all the time. That permission is only safe
 * because every path holding uncommitted work is protected per PR, against a
 * freshly read workingTreePaths() that includes untracked files, before
 * anything writes the tree. Do not relax one of those without the other. Git
 * refuses a merge that would overwrite an untracked file, so it is a backstop
 * for the case this misses, but it is a backstop and not the design: land runs
 * `git checkout HEAD --` and `git rm -f` after the merge, where git no longer
 * distinguishes your content from the session's, and the protected set is the
 * only thing that does.
 */
function requireLandableMain(): void {
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch !== "main")
		throw new Error(`land: HEAD is on ${branch}, not main. Ports land on main; switch first, nothing was merged.`);
	const staged = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
	if (staged.length > 0)
		throw new Error(
			`land: ${staged.length} path(s) are staged (${staged.slice(0, 3).join(", ")}${staged.length > 3 ? ", ..." : ""}). A merge commit takes the whole index, so these would ship inside a port. Commit or unstage them first; nothing was merged.`,
		);
}

/**
 * Every path holding work that exists only in the working tree, which land must
 * not write to under any circumstance.
 *
 * This is `git status --porcelain`, not `git diff --name-only`, and the
 * difference is the whole point: `git diff` reports modifications to tracked
 * files and says nothing about untracked ones. A file you created and have not
 * committed is invisible to it, so a check built on it will happily authorise
 * `git checkout HEAD --` or `git rm -f` over content that exists nowhere else
 * and cannot be recovered from any object in the repository. Untracked work is
 * the *most* fragile thing in the tree, not the least, and it is what this set
 * exists to protect.
 *
 * Renames are reported as `R  old -> new`, and both sides are returned: the
 * source path is as unsafe to write over as the destination.
 */
export function parseWorkingTreePaths(porcelain: string): Set<string> {
	const paths = new Set<string>();
	for (const line of porcelain.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain v1 is `XY <path>`, with `XY <old> -> <new>` for renames/copies.
		for (const part of line.slice(3).split(" -> ")) {
			const path = part.trim().replace(/^"(.*)"$/, "$1");
			if (path) paths.add(path);
		}
	}
	return paths;
}

/** Live snapshot of uncommitted work, tracked and untracked alike. */
function workingTreePaths(): Set<string> {
	return parseWorkingTreePaths(git("status", "--porcelain", "--untracked-files=all"));
}

/**
 * Drop every quarantined path back to what main holds, inside the in-progress
 * merge and before it is committed.
 *
 * Which command is right is a determinate question, so it is answered by asking
 * rather than by trying one and catching the failure. A path either exists in
 * HEAD, in which case main's content is restored over the session's edit, or it
 * does not, in which case the session invented the file and it is removed. The
 * previous shape here ran `checkout` and fell through to `rm -f
 * --ignore-unmatch` on any non-zero exit, which could not tell "not in main"
 * from "checkout failed" and discarded the outcome of both: a path could end up
 * restored, deleted, or silently untouched, and the caller could not tell which.
 * That is the fallback Law 10 bans, and here it deletes files.
 *
 * Every caller must have already proven each path is absent from
 * workingTreePaths(), because both branches write the tree. Returns the paths it
 * could not reset so the caller can abort rather than commit a merge still
 * carrying the noise the quarantine exists to strip.
 */
function resetQuarantined(paths: string[]): string[] {
	const failed: string[] = [];
	for (const path of paths) {
		const inMain = gitTry("cat-file", "-e", `HEAD:${path}`).ok;
		const reset = inMain ? gitTry("checkout", "HEAD", "--", path) : gitTry("rm", "-f", "--", path);
		if (!reset.ok) failed.push(`${path}: ${reset.out.split("\n")[0]}`);
	}
	return failed;
}

/**
 * Merge every clean open port PR into local main, oldest first.
 *
 * Nothing here presses GitHub's merge button. Each PR head is fetched, audited
 * with auditPortFiles, and merged locally with --no-ff so its head commit stays
 * in the history: when you push this main, GitHub sees the head SHA reachable
 * from the base and marks the PR merged on its own. That keeps the canonical
 * copy here and the mirror honest with no second source of truth.
 *
 * Refusals are loud and one-way: the PR is left open, its issue is labeled
 * port-review with the offending paths named, and the merge is never partially
 * applied (a conflicting merge is aborted, not resolved by guesswork).
 * Quarantined paths are dropped back to main's content inside the merge commit
 * and printed one per line, so the noise a session sheds never reaches history
 * and never silently disappears either.
 */
async function land(only: number[], push: boolean): Promise<void> {
	requireLandableMain();
	const policy = parseNeverPorted(readFileSync(POLICY_PATH, "utf8"));
	git("fetch", "origin", "main");

	const prs = (await ghAll(`/repos/${ORIGIN}/pulls?state=open&sort=created&direction=asc`, 300)).filter(
		(pr: any) => /^\s*port\(upstream#\d+\)/.test(pr.title) && (only.length === 0 || only.includes(pr.number)),
	);
	if (prs.length === 0) {
		console.log("land: no open port PRs match.");
		return;
	}

	const landed: number[] = [];
	const refused: string[] = [];
	for (const pr of prs) {
		const n = pr.number;
		const issueNumber = Number(/(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)/i.exec(pr.body ?? "")?.[1]);
		if (/^\s*NOT-APPLICABLE\b/i.test(pr.title)) {
			refused.push(`#${n} NOT-APPLICABLE verdict, not a port; close it by hand after reading its reasoning`);
			continue;
		}
		git("fetch", "origin", `pull/${n}/head:refs/jules-port/${n}`, "--force");
		const ref = `refs/jules-port/${n}`;
		// Diffed against local HEAD, not origin/main: this tree is the canonical
		// copy and is routinely ahead of the mirror, so auditing against origin
		// would judge the PR by a base it is not landing on.
		const files = git("diff", "--name-only", `HEAD...${ref}`).split("\n").filter(Boolean);
		if (files.length === 0) {
			refused.push(`#${n} changes nothing against main; close it`);
			continue;
		}
		// numstat is `<added>\t<removed>\t<path>`, with `-` for binary files.
		const shrunk = testFilesShrunk(
			git("diff", "--numstat", `HEAD...${ref}`)
				.split("\n")
				.filter(Boolean)
				.map(line => {
					const [added, removed, path] = line.split("\t");
					return { path, added: Number(added) || 0, removed: Number(removed) || 0 };
				}),
		);
		if (shrunk.length > 0) {
			const worst = shrunk.map(d => `${d.path} (-${d.removed}/+${d.added})`).join(", ");
			refused.push(`#${n} deletes test coverage: ${worst}`);
			if (Number.isFinite(issueNumber)) {
				await addLabels(issueNumber, [REVIEW_LABEL]);
				await comment(
					issueNumber,
					`Port PR #${n} was refused by \`jules-port-manager land\`: it shrinks ${shrunk.length} test file(s), so it removes more coverage than it adds.\n\n${shrunk.map(d => `- \`${d.path}\` -${d.removed}/+${d.added}`).join("\n")}\n\nThe fix itself may well be right. Re-do the port keeping main's existing test file intact and appending the new cases to it, rather than rewriting the suite around the new behaviour.`,
				);
			}
			continue;
		}
		// Re-read per PR rather than once before the loop: each landed merge
		// changes the tree, and a stale snapshot is exactly how a path stops being
		// listed as yours right before something writes over it.
		const dirty = workingTreePaths();
		// This is a safety check, not a convenience one. Both the merge and the
		// quarantine reset write these paths, and the reset writes them with
		// `checkout HEAD --` and `rm -f`, so a path carrying uncommitted work must
		// take the PR out of this run entirely rather than be resolved in place.
		const collisions = files.filter(f => dirty.has(f));
		if (collisions.length > 0) {
			refused.push(
				`#${n} touches ${collisions.length} path(s) you have uncommitted work in: ${collisions.join(", ")}`,
			);
			continue;
		}
		const audit = auditPortFiles(files, policy);
		if (audit.refuse.length > 0) {
			const shown = audit.refuse.slice(0, 8).join(", ");
			const more = audit.refuse.length > 8 ? ` (+${audit.refuse.length - 8} more)` : "";
			refused.push(`#${n} reverts main in ${audit.refuse.length}/${files.length} paths: ${shown}${more}`);
			if (Number.isFinite(issueNumber)) {
				await addLabels(issueNumber, [REVIEW_LABEL]);
				await comment(
					issueNumber,
					`Port PR #${n} was refused by \`jules-port-manager land\`: its diff modifies ${audit.refuse.length} path(s) that no port may touch, which means it is reversing work already on main rather than porting one fix.\n\n${audit.refuse.map(f => `- \`${f}\``).join("\n")}\n\nRe-do the port on a branch cut from current main, touching only the source that carries the bug plus its changelog entry.`,
				);
			}
			continue;
		}
		// resetQuarantined writes the tree, so it is only allowed to run on paths
		// proven free of uncommitted work. That holds today because quarantine is a
		// subset of `files`, which `collisions` already cleared, but the guarantee
		// belongs next to the code that depends on it: if the quarantine set ever
		// grows a source other than the PR diff, this fails closed instead of
		// silently regaining the ability to delete your work.
		const unsafe = audit.quarantine.filter(f => dirty.has(f));
		if (unsafe.length > 0) {
			refused.push(`#${n} would quarantine ${unsafe.length} path(s) holding uncommitted work: ${unsafe.join(", ")}`);
			continue;
		}
		// --no-commit so quarantined paths are reset before the merge commit
		// exists: the noise never enters history, and the PR head stays a parent
		// so pushing still marks the PR merged on GitHub.
		const merge = gitTry("merge", "--no-ff", "--no-commit", ref);
		if (!merge.ok && !/Automatic merge went well/.test(merge.out)) {
			gitTry("merge", "--abort");
			refused.push(`#${n} does not merge cleanly into main:\n      ${merge.out.split("\n")[0]}`);
			continue;
		}
		const unreset = resetQuarantined(audit.quarantine);
		if (unreset.length > 0) {
			gitTry("merge", "--abort");
			refused.push(
				`#${n} could not have its quarantined paths reset, so the merge would have carried session noise into history:\n      ${unreset.join("\n      ")}`,
			);
			continue;
		}
		const quarantineNote =
			audit.quarantine.length > 0
				? `\n\nQuarantined by land (session noise, not part of the fix):\n${audit.quarantine.map(f => `  ${f}`).join("\n")}`
				: "";
		const msg = `${pr.title}\n\nLands port PR #${n} into the canonical tree.${Number.isFinite(issueNumber) ? `\nCloses #${issueNumber}` : ""}${quarantineNote}`;
		const commit = gitTry("commit", "--no-verify", "-m", msg);
		if (!commit.ok) {
			gitTry("merge", "--abort");
			refused.push(`#${n} merge could not be committed:\n      ${commit.out.split("\n")[0]}`);
			continue;
		}
		landed.push(n);
		const dropped = audit.quarantine.length > 0 ? `, ${audit.quarantine.length} quarantined` : "";
		console.log(`land: merged #${n} (${files.length} files${dropped}) — ${pr.title.slice(0, 70)}`);
		for (const path of audit.quarantine) console.log(`land:   quarantined ${path}`);
	}

	for (const r of refused) console.log(`land: refused ${r}`);
	if (landed.length === 0) {
		console.log("land: nothing merged.");
		return;
	}
	console.log(`land: ${landed.length} port PR(s) merged into local main: ${landed.map(n => `#${n}`).join(" ")}`);
	if (!push) {
		console.log("land: not pushed. Run the gate, then `git push origin main` to mark them merged on GitHub.");
		return;
	}
	// The typecheck gates the push because a port can be individually reviewable
	// and still not compile against veyyon's types: PR #202 added four timeout
	// settings and the client code reading them, but never declared the two
	// interface fields it consumed, so `check:ts` failed on nine errors that no
	// per-PR audit could see. Pushing a red main would mark eight PRs merged and
	// break every branch cut afterwards, so this refuses instead.
	console.log("land: running check:ts before pushing...");
	const gate = Bun.spawnSync(["bun", "run", "check:ts"], { cwd: REPO_ROOT });
	if (gate.exitCode !== 0) {
		const errors = (gate.stdout?.toString() ?? "")
			.split("\n")
			.filter(l => /error TS\d+/.test(l))
			.slice(0, 10);
		console.error(`land: NOT pushed — check:ts failed on the merged tree.\n${errors.join("\n")}`);
		console.error(
			`land: the ${landed.length} merge(s) are in your local main. Fix the tree and push, or unwind the merges; nothing reached GitHub.`,
		);
		process.exit(1);
	}
	git("push", "origin", "main");
	console.log("land: pushed origin/main; GitHub will mark the landed PRs merged.");
}

// ---------------------------------------------------------------------------
// status: one table of pipeline truth — the operator's review dashboard.

/** Failing check names for a head SHA, deduped by check name (latest run wins). */
async function failingChecks(sha: string): Promise<string[]> {
	const runs = (await gh(`/repos/${ORIGIN}/commits/${sha}/check-runs?per_page=100`)).check_runs ?? [];
	const latest = new Map<string, string>();
	for (const run of runs) if (!latest.has(run.name)) latest.set(run.name, run.conclusion ?? "");
	return [...latest.entries()].filter(([, c]) => c === "failure").map(([name]) => name);
}

async function status(): Promise<void> {
	const all = (await ghAll(`/repos/${ORIGIN}/issues?labels=${QUEUE_LABEL}&state=open`, 2000)).filter(
		i => !i.pull_request,
	);
	const count = (label: string) => all.filter(i => hasLabel(i, label)).length;
	const queued = all.filter(
		i =>
			!hasLabel(i, DISPATCHED_LABEL) &&
			!hasLabel(i, PR_OPEN_LABEL) &&
			!hasLabel(i, REVIEW_LABEL) &&
			!hasLabel(i, BLOCKED_LABEL),
	).length;
	console.log(`pipeline (${ORIGIN} <- ${UPSTREAM}):`);
	console.log(`  queued          ${queued}`);
	console.log(`  in flight       ${count(DISPATCHED_LABEL)}`);
	console.log(`  pr open         ${count(PR_OPEN_LABEL)}`);
	console.log(
		`  needs human     ${count(REVIEW_LABEL)} (${REVIEW_LABEL}) + ${count(BLOCKED_LABEL)} (${BLOCKED_LABEL})`,
	);

	// The review pile, with the reason each item needs a human.
	for (const issue of all.filter(i => hasLabel(i, REVIEW_LABEL) || hasLabel(i, BLOCKED_LABEL))) {
		const comments = await issueComments(issue.number);
		const reason =
			comments
				.filter(b => /needs a human|blocked/i.test(b))
				.at(-1)
				?.split("\n")
				.find(l => l.trim() && !l.startsWith("<!--")) ?? "(see issue)";
		console.log(`    #${issue.number} ${issue.title.slice(0, 60)}\n      ${reason.slice(0, 140)}`);
	}

	// Open PRs with their check health, so "what can I merge?" is one glance.
	const openPrs = await ghAll(`/repos/${ORIGIN}/pulls?state=open`, 200);
	console.log(`  open PRs        ${openPrs.length} awaiting review`);
	for (const pr of openPrs) {
		const failing = await failingChecks(pr.head?.sha ?? "").catch(() => ["(checks unreadable)"]);
		const health = failing.length === 0 ? "checks green" : `failing: ${failing.join(", ")}`;
		console.log(`    #${pr.number} ${pr.title.slice(0, 70)} (${pr.user?.login})\n      ${health}`);
	}
	await usableLanes(resolveKeys());
}

// ---------------------------------------------------------------------------

let TOKEN = "";
if (import.meta.main) {
	TOKEN = ghToken();
	const cmd = process.argv[2] ?? "tick";
	if (cmd === "dispatch") await dispatch();
	else if (cmd === "harvest") await harvest();
	else if (cmd === "status") await status();
	else if (cmd === "land") {
		const rest = process.argv.slice(3);
		// Bare numbers select PRs; --push is opt-in so the default run stops at
		// a local merge you can still inspect, gate, and undo.
		await land(rest.filter(a => /^\d+$/.test(a)).map(Number), rest.includes("--push"));
	} else if (cmd === "tick") {
		await harvest();
		await dispatch();
	} else {
		console.error(`jules-port-manager: unknown command ${cmd} (want tick|dispatch|harvest|land|status)`);
		process.exit(2);
	}
}
