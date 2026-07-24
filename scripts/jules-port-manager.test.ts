import { describe, expect, it } from "bun:test";
import {
	buildPortPrompt,
	classifyHarvest,
	classifyPrOpen,
	countFailures,
	countNudges,
	countRecentSessions,
	extractPrUrl,
	failMarker,
	findPortPr,
	keyFingerprint,
	latestSessionMarker,
	nudgeMarker,
	parseEnvKeys,
	sessionMarker,
	upstreamNumberFromIssue,
} from "./jules-port-manager.ts";

/**
 * Key discovery reads /credentials/.env. If this parse regresses, dispatch
 * either runs with zero lanes (the pipeline silently stalls, the exact
 * failure that motivated this manager) or treats non-key JULES_* variables
 * as API keys and burns every request on 401s.
 */
describe("parseEnvKeys", () => {
	it("extracts only JULES_* variables whose value is an AQ. key, in order, deduped", () => {
		const env = [
			"DATABASE_URL=postgresql://u:p@h/db?sslmode=require",
			"JULES_MUKUND_LINUX_MAIN=AQ.Ab8xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1",
			"JULES_NOT_A_KEY=some-plain-value",
			"JULES_ACCOUNT_6=AQ.Ab8xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx2",
			"JULES_DUP=AQ.Ab8xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1",
			"OTHER_AQ=AQ.Ab8yyyy",
		].join("\n");
		expect(parseEnvKeys(env)).toEqual([
			"AQ.Ab8xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1",
			"AQ.Ab8xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx2",
		]);
	});

	it("returns an empty list for an env file with no Jules keys (dispatch then fails loud, not silent)", () => {
		expect(parseEnvKeys("A=1\nB=2\n")).toEqual([]);
	});
});

/**
 * The fingerprint is written into public issue comments to name the key that
 * owns a session. It must be stable (harvest routes polls by it) and must
 * never leak key material.
 */
describe("keyFingerprint", () => {
	it("is a stable 8-hex-char digest that contains no part of the key", () => {
		const fp = keyFingerprint("AQ.Ab8-secret-key-material");
		expect(fp).toMatch(/^[0-9a-f]{8}$/);
		expect(fp).toBe(keyFingerprint("AQ.Ab8-secret-key-material"));
		expect("AQ.Ab8-secret-key-material").not.toContain(fp);
	});

	it("distinguishes different keys", () => {
		expect(keyFingerprint("AQ.key-one")).not.toBe(keyFingerprint("AQ.key-two"));
	});
});

/**
 * Markers in issue comments ARE the pipeline's database. If round-tripping
 * breaks, harvest cannot find the session a dispatch created: every in-flight
 * issue would be "requeued" forever, dispatching duplicate sessions and
 * burning the whole daily quota on already-running work.
 */
describe("session markers", () => {
	it("round-trips a dispatch marker through comment text", () => {
		const body = `${sessionMarker("sessions/12345", "abcd1234")}\nDispatched Jules session.`;
		expect(latestSessionMarker([body])).toEqual({ session: "sessions/12345", fp: "abcd1234" });
	});

	it("returns the LATEST marker when retries created several sessions", () => {
		const c1 = sessionMarker("sessions/old", "aaaa1111");
		const c2 = `${failMarker("sessions/old")}\nfailed`;
		const c3 = sessionMarker("sessions/new", "bbbb2222");
		expect(latestSessionMarker([c1, c2, c3])).toEqual({ session: "sessions/new", fp: "bbbb2222" });
	});

	it("returns null when no dispatch ever happened", () => {
		expect(latestSessionMarker(["just a human comment", failMarker("sessions/x")])).toBeNull();
	});

	it("counts nudges per SESSION, so a retry session starts with a fresh nudge budget", () => {
		const comments = [nudgeMarker("sessions/old"), nudgeMarker("sessions/old"), nudgeMarker("sessions/new")];
		expect(countNudges(comments, "sessions/old")).toBe(2);
		expect(countNudges(comments, "sessions/new")).toBe(1);
		expect(countNudges(comments, "sessions/never")).toBe(0);
	});

	it("counts one failure per jules-failed marker and ignores everything else", () => {
		expect(
			countFailures([
				failMarker("sessions/a"),
				"human note",
				failMarker("sessions/b"),
				sessionMarker("sessions/c", "abcd1234"),
			]),
		).toBe(2);
		expect(countFailures([])).toBe(0);
	});
});

/**
 * The radar's upstream marker links a port issue back to the oh-my-pi PR it
 * mirrors; findPortPr uses it as a secondary PR match. Losing it would only
 * leave the Closes-line match, so a Jules PR that forgot the line would
 * never flip its issue to pr-open.
 */
describe("upstreamNumberFromIssue", () => {
	it("reads the radar marker", () => {
		expect(upstreamNumberFromIssue("<!-- upstream-pr: 6413 -->\nUpstream merged PR: ...")).toBe(6413);
	});
	it("is null when the marker is absent (a hand-filed issue)", () => {
		expect(upstreamNumberFromIssue("no marker here")).toBeNull();
	});
});

/**
 * The prompt is the entire contract between the pipeline and the Jules agent.
 * Two clauses are load-bearing: the Closes line (merging the PR must close
 * the issue, or the queue never drains) and the NOT-APPLICABLE protocol
 * (harvest routes PR-less completions to a human based on it).
 */
describe("buildPortPrompt", () => {
	it("mandates the exact Closes line for the issue and embeds the radar's brief verbatim", () => {
		const p = buildPortPrompt(167, "## Task: evaluate and port\n- `packages/ai/src/stream.ts`", null);
		expect(p).toContain("Closes #167");
		expect(p).toContain("issue #167");
		expect(p).toContain("## Task: evaluate and port\n- `packages/ai/src/stream.ts`");
		expect(p).toContain("NOT-APPLICABLE:");
		expect(p).not.toContain("Previous attempt failed");
	});

	it("bans scratch artifacts in the PR (live finding: a session committed the downloaded 6227.diff to the repo root)", () => {
		expect(buildPortPrompt(40, "body", null)).toContain("Never commit scratch artifacts");
	});

	it("folds the prior failure context into a retry so the next session sees the dead end", () => {
		const p = buildPortPrompt(167, "body", "Session failed: session state FAILED\nbun test exploded");
		expect(p).toContain("## Previous attempt failed");
		expect(p).toContain("bun test exploded");
	});

	it("bounds a huge failure context instead of blowing up the prompt", () => {
		const p = buildPortPrompt(1, "body", "x".repeat(10_000));
		expect(p.length).toBeLessThan(4_000);
	});
});

/**
 * PR-to-issue matching flips an issue to pr-open. A false positive marks a
 * port done that never landed (the port silently drops, the exact recall
 * loss this pipeline exists to prevent); a number-prefix collision (#16 vs
 * #167) is the classic way that happens.
 */
describe("findPortPr", () => {
	const pr = (number: number, title: string, body: string | null) => ({
		number,
		title,
		body,
		html_url: `https://github.com/santhreal/veyyon/pull/${number}`,
	});

	it("matches the mandated Closes line", () => {
		const prs = [pr(30, "port(upstream#6413): feat(cli): bench cache", "Ports the change.\n\nCloses #167")];
		expect(findPortPr(prs, 167, 6413)?.number).toBe(30);
	});

	it("matches the radar port(upstream#N) title when the Closes line was forgotten", () => {
		const prs = [pr(31, "port(upstream#6413): feat(cli): bench cache", "no reference")];
		expect(findPortPr(prs, 167, 6413)?.number).toBe(31);
	});

	it("never lets #16 claim a PR that references #167", () => {
		const prs = [pr(32, "some port", "Closes #167")];
		expect(findPortPr(prs, 16, null)).toBeNull();
	});

	it("returns null when nothing references the issue", () => {
		expect(findPortPr([pr(33, "chore(deps): bump flume", "dependabot body")], 167, 6413)).toBeNull();
	});

	it("never lets a bare #N in a dependabot changelog quote claim the port (live risk: dep bodies quote other repos' issue numbers)", () => {
		const prs = [
			pr(
				34,
				"chore(deps): bump flume from 0.11.1 to 0.12.0",
				"Changelog\n- fixed shutdown race (#45)\n- perf (#167)",
			),
		];
		expect(findPortPr(prs, 45, null)).toBeNull();
		expect(findPortPr(prs, 167, null)).toBeNull();
	});

	it("accepts a bare #N inside a PR Jules itself authored (its auto-footer names the task, not a Closes line)", () => {
		const body =
			"Ports the thing for #45.\n\n---\n*PR created automatically by Jules for task 123 started by @santhreal*";
		expect(findPortPr([pr(35, "some port", body)], 45, null)?.number).toBe(35);
	});
});

/**
 * classifyPrOpen closes the last gap in the label state machine: an issue in
 * port-pr-open whose PR is rejected (closed unmerged) previously stranded
 * forever, silently dropping the port; a merged PR with a mangled Closes line
 * left a done issue open. Both are recall bugs in the pipeline itself.
 */
describe("classifyPrOpen", () => {
	const base = { number: 181, title: "port(upstream#6227): fix", body: "Closes #40", html_url: "u" };

	it("keeps waiting while the PR is open for review", () => {
		expect(classifyPrOpen({ ...base, state: "open", merged_at: null })).toEqual({ kind: "keep" });
	});

	it("closes the issue when the PR merged (the Closes line should have, but must not be load-bearing)", () => {
		expect(classifyPrOpen({ ...base, state: "closed", merged_at: "2026-07-24T20:00:00Z" }).kind).toBe("close");
	});

	it("requeues the issue when the PR was closed WITHOUT merging (a rejected port is not a done port)", () => {
		expect(classifyPrOpen({ ...base, state: "closed", merged_at: null }).kind).toBe("requeue");
	});

	it("routes to a human when the label exists but no PR references the issue", () => {
		expect(classifyPrOpen(null).kind).toBe("review");
	});

	it("treats a NOT-APPLICABLE PR as a verdict to verify, never a port (live: AUTO_CREATE_PR opened empty PR #183 to carry the verdict)", () => {
		const na = {
			number: 183,
			title: "NOT-APPLICABLE: port(upstream#6240): fix(tui): lock plan",
			body: "Closes #32\n\nNOT-APPLICABLE: superseded",
			html_url: "u",
		};
		expect(classifyPrOpen({ ...na, state: "open", merged_at: null }).kind).toBe("review");
		// Closing the verdict PR unmerged must NOT requeue: the port would be
		// re-attempted forever on a change that provably does not apply.
		expect(classifyPrOpen({ ...na, state: "closed", merged_at: null }).kind).toBe("review");
	});

	it("detects the verdict from the body when only the body carries NOT-APPLICABLE", () => {
		const pr = {
			number: 9,
			title: "port(upstream#1): fix",
			body: "NOT-APPLICABLE: veyyon rewrote this",
			html_url: "u",
			state: "open",
			merged_at: null,
		};
		expect(classifyPrOpen(pr).kind).toBe("review");
	});
});

/**
 * Budget counting is the only thing standing between the manager and blowing
 * a shared Ultra daily cap that other pipelines (the Santh drain) also spend
 * from. Over-counting stalls porting; under-counting starves the other
 * pipelines mid-day.
 */
describe("countRecentSessions", () => {
	const now = Date.parse("2026-07-24T12:00:00Z");
	it("counts only sessions inside the rolling window", () => {
		const times = [
			"2026-07-24T11:00:00Z", // 1h ago: in
			"2026-07-23T12:00:01Z", // just inside 24h: in
			"2026-07-23T11:59:59Z", // just outside: out
			"2026-07-20T00:00:00Z", // days old: out
		];
		expect(countRecentSessions(times, now, 24)).toBe(2);
	});
	it("never lets an unparseable createTime inflate usage", () => {
		expect(countRecentSessions(["not-a-date", ""], now, 24)).toBe(0);
	});
});

/**
 * PR extraction is schema-agnostic on purpose: the v1alpha session resource
 * does not document where a created PR lands, so harvest scans the whole
 * JSON. It must only ever match THIS repo's pulls: an upstream oh-my-pi PR
 * URL quoted inside the prompt must never count as our port PR.
 */
describe("extractPrUrl", () => {
	it("finds an origin PR URL anywhere in the session resource", () => {
		expect(extractPrUrl({ outputs: [{ artifact: { url: "https://github.com/santhreal/veyyon/pull/42" } }] })).toBe(
			"https://github.com/santhreal/veyyon/pull/42",
		);
	});
	it("ignores upstream PR URLs embedded in the prompt", () => {
		expect(extractPrUrl({ prompt: "port https://github.com/can1357/oh-my-pi/pull/6413" })).toBeNull();
	});
});

/**
 * classifyHarvest is the pipeline's routing brain. Each branch below pins a
 * distinct production consequence: a wrong route either burns quota retrying
 * finished/waiting sessions or strands an issue in-flight forever.
 */
describe("classifyHarvest", () => {
	it("a PR wins over any session state, even FAILED (the artifact exists)", () => {
		expect(classifyHarvest("FAILED", "https://github.com/santhreal/veyyon/pull/9", 1, 24)).toEqual({
			kind: "pr-open",
			url: "https://github.com/santhreal/veyyon/pull/9",
		});
	});

	it("terminal failure states requeue via the failure budget", () => {
		for (const s of ["FAILED", "ERROR", "CANCELLED", "failed"]) {
			expect(classifyHarvest(s, null, 1, 24).kind).toBe("failed");
		}
	});

	it("COMPLETED with no PR goes to a human, never a blind retry", () => {
		expect(classifyHarvest("COMPLETED", null, 1, 24).kind).toBe("review");
	});

	it("a fresh in-flight session waits", () => {
		expect(classifyHarvest("IN_PROGRESS", null, 2, 24)).toEqual({ kind: "wait" });
	});

	it("a session silently in-flight past the stale window is dead: requeue it", () => {
		expect(classifyHarvest("IN_PROGRESS", null, 30, 24).kind).toBe("failed");
	});

	it("a session asking for input gets the autonomy nudge while budget remains (seen live: Jules pauses mid-port to ask 'should I run the tests?')", () => {
		expect(classifyHarvest("AWAITING_USER_FEEDBACK", null, 2, 24, 0, 3).kind).toBe("nudge");
		expect(classifyHarvest("AWAITING_USER_FEEDBACK", null, 2, 24, 2, 3).kind).toBe("nudge");
		// A questioning session is nudged even past the stale window: an answer
		// is cheaper than abandoning a mostly-done port.
		expect(classifyHarvest("AWAITING_USER_FEEDBACK", null, 30, 24, 0, 3).kind).toBe("nudge");
	});

	it("a session still asking after the nudge budget, past the window, needs a human answer, not a retry", () => {
		expect(classifyHarvest("AWAITING_USER_FEEDBACK", null, 30, 24, 3, 3).kind).toBe("review");
		// Out of nudges but inside the window: wait for the stale clock, a late
		// auto-advance is still possible.
		expect(classifyHarvest("AWAITING_USER_FEEDBACK", null, 2, 24, 3, 3).kind).toBe("wait");
	});
});
