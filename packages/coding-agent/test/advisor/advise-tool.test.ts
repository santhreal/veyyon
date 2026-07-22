import { describe, expect, it } from "bun:test";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	annotateForStaleness,
	deriveAdvisorTelemetry,
	formatAdvisorBatchContent,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
	resolveAdvisorDeliveryChannel,
} from "@veyyon/coding-agent/advisor/advise-tool";

/**
 * The advisor decides how a read-only reviewer's notes reach the running primary agent:
 * what the agent-facing `<advisory>` block looks like, which severities interrupt, and
 * which delivery channel (aside queue / live steer / preserved card) each note takes.
 * These pure decision functions carry the whole routing contract yet were untested. The
 * delivery-channel precedence in particular guards a real bug (its own doc comment):
 * parking an interrupting note during an active resumed run strands it until it dumps as
 * one burst at the next user prompt. These pin every branch so that precedence, and the
 * XML escaping that keeps note text from breaking the advisory envelope, cannot regress.
 */

describe("formatAdvisorBatchContent", () => {
	it("renders severity and advisor as attributes, omitting them when absent", () => {
		expect(formatAdvisorBatchContent([{ note: "hi", severity: "concern", advisor: "sec" }])).toBe(
			'<advisory advisor="sec" severity="concern" guidance="weigh, don\'t blindly obey">\nhi\n</advisory>',
		);
		expect(formatAdvisorBatchContent([{ note: "plain note" }])).toBe(
			'<advisory guidance="weigh, don\'t blindly obey">\nplain note\n</advisory>',
		);
	});

	it("escapes < and & in note text and quotes in the advisor attribute", () => {
		// The body escapes markup characters; the attribute additionally escapes the
		// double quote that would otherwise close the attribute early.
		expect(formatAdvisorBatchContent([{ note: 'a < b & "c"', advisor: 'a"b' }])).toBe(
			'<advisory advisor="a&quot;b" guidance="weigh, don\'t blindly obey">\na &lt; b &amp; "c"\n</advisory>',
		);
	});

	it("joins multiple notes with a single newline", () => {
		expect(formatAdvisorBatchContent([{ note: "n1" }, { note: "n2", severity: "nit" }])).toBe(
			'<advisory guidance="weigh, don\'t blindly obey">\nn1\n</advisory>\n' +
				'<advisory severity="nit" guidance="weigh, don\'t blindly obey">\nn2\n</advisory>',
		);
	});
});

describe("isInterruptingSeverity", () => {
	it("interrupts on concern and blocker, queues a nit or missing severity", () => {
		expect(isInterruptingSeverity("concern")).toBe(true);
		expect(isInterruptingSeverity("blocker")).toBe(true);
		expect(isInterruptingSeverity("nit")).toBe(false);
		expect(isInterruptingSeverity(undefined)).toBe(false);
	});
});

describe("annotateForStaleness", () => {
	it("returns the note unchanged when the backlog is not fresh", () => {
		expect(annotateForStaleness("x", false)).toBe("x");
	});

	it("appends a staleness caveat when newer primary turns arrived", () => {
		expect(annotateForStaleness("x", true)).toBe(
			"x\n\n_(Note: newer primary turns arrived after this reviewed window — verify this still applies.)_",
		);
	});
});

describe("isAdvisorInterruptImmuneTurnActive", () => {
	it("is a half-open fence [start, start+immuneTurns) and disabled without a start or turns", () => {
		expect(
			isAdvisorInterruptImmuneTurnActive({ completedTurns: 5, immuneTurnStart: undefined, immuneTurns: 3 }),
		).toBe(false);
		expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 5, immuneTurnStart: 4, immuneTurns: 0 })).toBe(false);
		expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 5, immuneTurnStart: 4, immuneTurns: 3 })).toBe(true);
		// start + immuneTurns = 7 is excluded (half-open).
		expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 7, immuneTurnStart: 4, immuneTurns: 3 })).toBe(false);
		expect(isAdvisorInterruptImmuneTurnActive({ completedTurns: 8, immuneTurnStart: 4, immuneTurns: 3 })).toBe(false);
	});
});

describe("resolveAdvisorDeliveryChannel", () => {
	const base = { severity: "concern" as const, autoResumeSuppressed: false, streaming: false, aborting: false };

	it("routes non-interrupting notes to the aside queue regardless of run state", () => {
		expect(resolveAdvisorDeliveryChannel({ ...base, severity: "nit" })).toBe("aside");
		expect(resolveAdvisorDeliveryChannel({ ...base, severity: undefined, streaming: true })).toBe("aside");
	});

	it("steers an interrupting note whether the primary is idle or streaming", () => {
		expect(resolveAdvisorDeliveryChannel({ ...base, streaming: false })).toBe("steer");
		expect(resolveAdvisorDeliveryChannel({ ...base, streaming: true })).toBe("steer");
	});

	it("preserves an interrupting note after a user interrupt while idle or still aborting", () => {
		expect(resolveAdvisorDeliveryChannel({ ...base, autoResumeSuppressed: true, streaming: false })).toBe("preserve");
		expect(
			resolveAdvisorDeliveryChannel({ ...base, autoResumeSuppressed: true, aborting: true, streaming: true }),
		).toBe("preserve");
	});

	it("steers (not parks) an interrupting note once the run is streaming again after a suppressed resume", () => {
		// The guarded bug: parking here strands the note until the next user prompt.
		expect(
			resolveAdvisorDeliveryChannel({ ...base, autoResumeSuppressed: true, streaming: true, aborting: false }),
		).toBe("steer");
	});

	it("preserves a late interrupting note on a terminal answer with no queued work", () => {
		expect(resolveAdvisorDeliveryChannel({ ...base, terminalAnswerNoQueuedWork: true })).toBe("preserve");
		// but not while a turn is streaming.
		expect(resolveAdvisorDeliveryChannel({ ...base, terminalAnswerNoQueuedWork: true, streaming: true })).toBe(
			"steer",
		);
	});

	it("downgrades to an aside during the immune window, but preservation still wins", () => {
		expect(resolveAdvisorDeliveryChannel({ ...base, interruptImmuneTurnActive: true, streaming: true })).toBe(
			"aside",
		);
		expect(
			resolveAdvisorDeliveryChannel({
				...base,
				autoResumeSuppressed: true,
				streaming: false,
				interruptImmuneTurnActive: true,
			}),
		).toBe("preserve");
	});
});

describe("deriveAdvisorTelemetry", () => {
	it("returns undefined when the primary has no telemetry", () => {
		expect(deriveAdvisorTelemetry(undefined, { name: "adv" } as never)).toBeUndefined();
	});

	it("re-stamps the advisor identity and clears the conversation id, keeping the rest", () => {
		const derived = deriveAdvisorTelemetry(
			{ agent: "old", conversationId: "cid", extra: 1 } as never,
			{ name: "adv" } as never,
		);
		expect(derived).toEqual({ agent: { name: "adv" }, conversationId: undefined, extra: 1 } as never);
	});
});

describe("ADVISOR_DEFAULT_TOOL_NAMES", () => {
	it("is exactly the read-only investigative set", () => {
		expect([...ADVISOR_DEFAULT_TOOL_NAMES]).toEqual(["read", "grep", "glob"]);
	});
});
