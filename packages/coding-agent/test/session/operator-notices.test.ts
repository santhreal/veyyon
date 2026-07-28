/**
 * The channel that makes a non-fatal problem reach a person.
 *
 * WHY THIS SUITE EXISTS. Every warning in this codebase used to go one of two places, and neither
 * was a person: `logger.warn` writes to a file with no console transport, and
 * `AgentSession.skillWarnings` was a getter that production code never read. So the behaviour
 * worth pinning is not "a notice can be added" but the three ways a notice channel silently
 * stops working:
 *
 *   1. A notice raised BEFORE a surface exists is dropped. This is the normal case, not an edge
 *      case: session startup is exactly when skills fail to load and secrets turn out to be
 *      unprotectable, and the TUI does not exist yet.
 *   2. A caller that attaches no surface at all loses everything, quietly.
 *   3. The same problem repeats every turn until the operator stops reading the channel, which
 *      ends in the same silence by a different route.
 */
import { describe, expect, it } from "bun:test";
import {
	formatNotice,
	type OperatorNotice,
	OperatorNotices,
} from "@veyyon/coding-agent/session/operator-notices";

/** Collect into an array, the way a surface would. */
function collector(): { seen: OperatorNotice[]; sink: (notice: OperatorNotice) => void } {
	const seen: OperatorNotice[] = [];
	return { seen, sink: notice => seen.push(notice) };
}

describe("a notice raised before any surface exists", () => {
	/**
	 * THE BUG THIS LOCKS OUT, and the reason the class buffers at all.
	 *
	 * Session startup raises warnings; the TUI cannot render until its screen exists. A channel
	 * that delivered only to a currently-attached sink would drop precisely the notices that
	 * matter most, and would do it in the one configuration everybody runs.
	 */
	it("is delivered when the surface attaches", () => {
		const notices = new OperatorNotices();
		notices.warn("skills", "deploy/SKILL.md: frontmatter is missing a description");

		const { seen, sink } = collector();
		notices.setSink(sink);

		expect(seen).toHaveLength(1);
		expect(seen[0].source).toBe("skills");
		expect(seen[0].text).toBe("deploy/SKILL.md: frontmatter is missing a description");
		expect(seen[0].severity).toBe("warning");
	});

	/** Order is preserved, so a sequence of startup problems reads as it happened. */
	it("is delivered in the order it was raised", () => {
		const notices = new OperatorNotices();
		notices.warn("skills", "first");
		notices.error("secrets", "second");
		notices.warn("skills", "third");

		const { seen, sink } = collector();
		notices.setSink(sink);

		expect(seen.map(n => n.text)).toEqual(["first", "second", "third"]);
	});

	/** Buffered until then, and readable, so a test or a diagnostic can see the queue. */
	it("is listed as pending until a surface exists", () => {
		const notices = new OperatorNotices();
		notices.warn("secrets", "waiting");

		expect(notices.pending().map(n => n.text)).toEqual(["waiting"]);

		notices.setSink(() => {});
		expect(notices.pending()).toHaveLength(0);
	});
});

describe("a notice raised after the surface exists", () => {
	/** Arrives immediately, so a runtime problem is not held until some later flush. */
	it("goes straight to the sink", () => {
		const { seen, sink } = collector();
		const notices = new OperatorNotices(sink);

		notices.warn("secrets", "pattern matched a 3-character value");

		expect(seen.map(n => n.text)).toEqual(["pattern matched a 3-character value"]);
		expect(notices.pending()).toHaveLength(0);
	});

	/**
	 * Replacing a surface does NOT redeliver what the previous one already showed.
	 *
	 * A session that swaps surfaces (a TUI that rebuilds its screen) would otherwise repeat every
	 * startup warning, which reads as a new problem each time.
	 */
	it("is not redelivered when the surface is replaced", () => {
		const first = collector();
		const notices = new OperatorNotices(first.sink);
		notices.warn("skills", "already shown");

		const second = collector();
		notices.setSink(second.sink);

		expect(first.seen).toHaveLength(1);
		expect(second.seen).toHaveLength(0);
	});
});

describe("a repeated problem", () => {
	/**
	 * Collapses to one notice.
	 *
	 * A pattern that over-matches is detected once per message and an audit write that fails keeps
	 * failing. Repeating either every turn trains the operator to ignore the channel, which is the
	 * same outcome as having no channel at all.
	 */
	it("is shown once, not once per detection", () => {
		const { seen, sink } = collector();
		const notices = new OperatorNotices(sink);

		for (let i = 0; i < 50; i++) notices.warn("secrets", "entry 2 matched a 3-character value");

		expect(seen).toHaveLength(1);
		expect(notices.all()).toHaveLength(1);
	});

	/** Two DIFFERENT problems from one source are both shown: collapsing is by text, not source. */
	it("does not hide a different problem from the same source", () => {
		const { seen, sink } = collector();
		const notices = new OperatorNotices(sink);

		notices.warn("secrets", "entry 2 over-matched");
		notices.warn("secrets", "entry 5 over-matched");

		expect(seen.map(n => n.text)).toEqual(["entry 2 over-matched", "entry 5 over-matched"]);
	});

	/** Severity is part of the identity, so a warning that becomes an error is still seen. */
	it("is shown again when its severity changes", () => {
		const { seen, sink } = collector();
		const notices = new OperatorNotices(sink);

		notices.warn("secrets", "the log could not be appended to");
		notices.error("secrets", "the log could not be appended to");

		expect(seen.map(n => n.severity)).toEqual(["warning", "error"]);
	});

	/**
	 * Two notices that only differ in where the source ends are both shown.
	 *
	 * The identity key joins severity, source and text, and the separator between
	 * them was written into the source as a LITERAL NUL byte, which is invisible
	 * in an editor and in a diff: the line reads as a template with no separator
	 * at all. A key built without one collapses any pair whose concatenation
	 * matches, so `secrets` + `-audit failed` and `secrets-audit` + ` failed` are
	 * one notice and the second problem is silently never reported. The separator
	 * is an escape now, and this is the pair that tells the difference.
	 */
	it("does not collapse two problems whose source and text only differ in where they split", () => {
		const { seen, sink } = collector();
		const notices = new OperatorNotices(sink);

		notices.warn("secrets", "-audit failed");
		notices.warn("secrets-audit", " failed");

		expect(seen.map(n => `${n.source}|${n.text}`)).toEqual(["secrets|-audit failed", "secrets-audit| failed"]);
	});

	/** The first occurrence's timestamp is kept, so "when did this start" is answerable. */
	it("keeps the timestamp of the first occurrence", () => {
		const { seen, sink } = collector();
		const notices = new OperatorNotices(sink);

		notices.add({ severity: "warning", source: "secrets", text: "same", at: 1000 });
		notices.add({ severity: "warning", source: "secrets", text: "same", at: 9000 });

		expect(seen).toHaveLength(1);
		expect(seen[0].at).toBe(1000);
	});
});

describe("the record of what was raised", () => {
	/** `all` includes delivered notices, so a diagnostic does not have to have been attached. */
	it("survives delivery", () => {
		const notices = new OperatorNotices(() => {});
		notices.warn("skills", "one");
		notices.error("secrets", "two");

		expect(notices.all().map(n => `${n.severity}/${n.source}/${n.text}`)).toEqual([
			"warning/skills/one",
			"error/secrets/two",
		]);
	});

	/** Empty is distinguishable from "nothing attached", which is what makes it usable as a gate. */
	it("reports emptiness", () => {
		const notices = new OperatorNotices();
		expect(notices.isEmpty).toBe(true);

		notices.warn("secrets", "something");
		expect(notices.isEmpty).toBe(false);
	});
});

describe("rendering", () => {
	/** `source: text`, exact bytes, because this is what an operator reads. */
	it("names the subsystem in front of the message", () => {
		expect(
			formatNotice({ severity: "warning", source: "skills", text: "deploy/SKILL.md: no description", at: 0 }),
		).toBe("skills: deploy/SKILL.md: no description");
	});
});
