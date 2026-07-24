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

const QUEUE_LABEL = "upstream-port";
const DISPATCHED_LABEL = "jules-dispatched";
const PR_OPEN_LABEL = "port-pr-open";
const REVIEW_LABEL = "port-review";
const BLOCKED_LABEL = "port-blocked";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in jules-port-manager.test.ts).

/** Every `JULES_*=AQ.*` value in an env file body, in file order, deduped. */
export function parseEnvKeys(envText: string): string[] {
	const keys: string[] = [];
	for (const line of envText.split("\n")) {
		const m = /^(JULES_[A-Z0-9_]+)=(AQ\.\S+)\s*$/.exec(line.trim());
		if (m && !keys.includes(m[2])) keys.push(m[2]);
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
- Commit ONLY the ported source, tests, docs, and changelog. Never commit scratch artifacts: downloaded \`*.diff\`/\`*.patch\` files, notes, or tool output.
- If the change does NOT apply to veyyon (superseded, subsystem rewritten or removed), do not open a PR; end the session with a summary that starts with \`NOT-APPLICABLE:\` and names the veyyon change that supersedes it.
`;
}

/**
 * The port PR for an issue among a PR list: its body carries `Closes #N` (the
 * prompt mandates it), or its title carries the radar's `port(upstream#M)`
 * prefix for the mirrored upstream PR M. Word-boundary match so #16 never
 * claims #167's PR.
 */
export function findPortPr(
	prs: Array<{ number: number; title: string; body: string | null; html_url: string }>,
	issueNumber: number,
	upstreamNumber: number | null,
): { number: number; html_url: string } | null {
	const closes = new RegExp(`(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
	const bare = new RegExp(`#${issueNumber}\\b`);
	for (const pr of prs) {
		const body = pr.body ?? "";
		if (closes.test(body) || bare.test(body)) return pr;
		if (upstreamNumber !== null && pr.title.includes(`port(upstream#${upstreamNumber})`)) return pr;
	}
	return null;
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

// ---------------------------------------------------------------------------
// Key discovery and per-key budget.

interface Lane {
	key: string;
	fp: string;
	remaining: number;
}

function resolveKeys(): string[] {
	const inline = process.env.JULES_API_KEYS;
	if (inline)
		return inline
			.split(",")
			.map(k => k.trim())
			.filter(Boolean);
	let text: string;
	try {
		text = readFileSync(ENV_FILE, "utf8");
	} catch {
		throw new Error(`jules-port-manager: JULES_API_KEYS unset and ${ENV_FILE} unreadable. No Jules keys available.`);
	}
	return parseEnvKeys(text);
}

/** Keys that can see the origin repo, with their remaining 24h session budget. */
async function usableLanes(keys: string[]): Promise<Lane[]> {
	const lanes: Lane[] = [];
	for (const key of keys) {
		const fp = keyFingerprint(key);
		try {
			await jules(key, `/${SOURCE}`);
		} catch {
			console.log(`lane ${fp}: cannot see ${ORIGIN} (Jules app not granted on this account); skipping.`);
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
		lanes.push({ key, fp, remaining: Math.max(0, KEY_DAILY_BUDGET - used) });
		console.log(
			`lane ${fp}: ${used} sessions in the last ${WINDOW_HOURS}h, ${Math.max(0, KEY_DAILY_BUDGET - used)}/${KEY_DAILY_BUDGET} budget left.`,
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
	if (inflight.length === 0) {
		console.log("harvest: nothing in flight.");
		return;
	}
	const lanes = resolveKeys().map(key => ({ key, fp: keyFingerprint(key) }));
	// One PR listing serves every issue this run.
	const prs = await ghAll(`/repos/${ORIGIN}/pulls?state=all&sort=created&direction=desc`, 300);
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
			case "review":
				await addLabels(issue.number, [REVIEW_LABEL]);
				await removeLabel(issue.number, DISPATCHED_LABEL);
				await comment(
					issue.number,
					`Session [\`${marker.session}\`](${session.url ?? ""}) needs a human: ${action.reason}. If it declared NOT-APPLICABLE, verify the reasoning and close this issue; otherwise resolve and remove \`${REVIEW_LABEL}\` to requeue.`,
				);
				console.log(`harvest: #${issue.number} -> ${REVIEW_LABEL} (${action.reason}).`);
				break;
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
// status: one table of pipeline truth.

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
	const openPrs = await ghAll(`/repos/${ORIGIN}/pulls?state=open`, 200);
	console.log(`  open PRs        ${openPrs.length} total awaiting review`);
	for (const pr of openPrs) console.log(`    #${pr.number} ${pr.title.slice(0, 80)} (${pr.user?.login})`);
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
	else if (cmd === "tick") {
		await harvest();
		await dispatch();
	} else {
		console.error(`jules-port-manager: unknown command ${cmd} (want tick|dispatch|harvest|status)`);
		process.exit(2);
	}
}
