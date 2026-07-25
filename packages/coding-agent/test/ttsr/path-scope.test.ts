/**
 * `pathScope` decides a rule's match by where the matched path is, not only by what it looks like.
 *
 * WHY THIS SUITE EXISTS. A TTSR condition is a regex over the model's output, and a regex cannot know
 * the session's working directory. That is fine for a rule about syntax (`ts-no-any` does not care
 * where the file is) and useless for a rule whose entire premise is "this path is somewhere else".
 * `cwd-reroot` is that rule, and it was firing on any absolute path with four or more segments —
 * including every absolute path INSIDE the working directory, which a model produces constantly from
 * grep output, a tool header echoed back, or a path it happened to have in absolute form. The advice
 * it then injected was "re-root to that project", about the project the session was already rooted in.
 * A nudge that is wrong that often is worse than no nudge: it costs tokens on every occurrence and
 * teaches the model to ignore the channel it arrives on.
 *
 * So `pathScope: outside-cwd` (or `inside-cwd`) is checked against the path the condition ACTUALLY
 * matched, at match time, against the live working directory. At match time and not at registration
 * because `set_cwd` moves the working directory mid-session, and the rule most likely to carry this
 * flag is the one telling the model to call it: a snapshot taken when the rule was registered would
 * go stale exactly when the advice was followed.
 *
 * The absent-working-directory case fails CLOSED, and that is asserted below rather than left to
 * inference. A rule that asked to be filtered must not fire unfiltered, because firing unfiltered is
 * the behaviour it was written to stop.
 */

import { describe, expect, it } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";

const CWD = "/work/project";

/** A rule whose condition matches any absolute path of four or more segments. */
function pathRule(overrides: Partial<Rule> = {}): Rule {
	return {
		name: "path-rule",
		path: "/rules/path-rule.md",
		content: "body",
		condition: ["(?:^|[\\s\"'=(,])/(?:[\\w.@+-]+/){3,}[\\w.@+-]+"],
		scope: ["tool:read"],
		interruptMode: "never",
		_source: { provider: "test", providerName: "test", path: "/rules/path-rule.md", level: "project" },
		...overrides,
	};
}

/** Fire one tool delta through a fresh manager and return the rule names that matched. */
function match(rule: Rule, delta: string, options?: { getCwd?: () => string }): string[] {
	const manager = new TtsrManager(undefined, options);
	expect(manager.addRule(rule)).toBe(true);
	return manager.checkDelta(delta, { source: "tool", toolName: "read" }).map(r => r.name);
}

const INSIDE = '{"path":"/work/project/packages/agent/src/turn.ts"}';
const OUTSIDE = '{"path":"/work/other-project/crates/cli/src/main.rs"}';

describe("a rule with no pathScope", () => {
	it("matches wherever the path is, which is every rule that does not opt in", () => {
		// The default has to stay exactly as it was: 26 of the 27 bundled rules carry no pathScope
		// and must be unaffected by its existence.
		expect(match(pathRule(), INSIDE, { getCwd: () => CWD })).toEqual(["path-rule"]);
		expect(match(pathRule(), OUTSIDE, { getCwd: () => CWD })).toEqual(["path-rule"]);
	});

	it("matches even when the manager knows no working directory", () => {
		expect(match(pathRule(), OUTSIDE)).toEqual(["path-rule"]);
	});
});

describe("pathScope: outside-cwd", () => {
	const rule = pathRule({ pathScope: "outside-cwd" });

	it("fires for a path in a different project", () => {
		expect(match(rule, OUTSIDE, { getCwd: () => CWD })).toEqual(["path-rule"]);
	});

	/** THE regression. This is the case that made the nudge advise a move to where it already was. */
	it("does not fire for an absolute path inside the working directory", () => {
		expect(match(rule, INSIDE, { getCwd: () => CWD })).toEqual([]);
	});

	it("does not fire for the working directory itself", () => {
		// The boundary. `path.relative(cwd, cwd)` is the empty string, which is neither inside nor
		// outside by string comparison and has to be decided deliberately: naming the root is not
		// reaching into another project.
		expect(match(rule, `{"path":"${CWD}"}`, { getCwd: () => CWD })).toEqual([]);
	});

	it("fires for a sibling directory whose name merely starts with the working directory's", () => {
		// `/work/project-two` shares a string prefix with `/work/project` and is a different tree.
		// A prefix comparison calls it inside and stays silent; the check resolves paths instead.
		expect(match(rule, '{"path":"/work/project-two/src/a/b.ts"}', { getCwd: () => CWD })).toEqual(["path-rule"]);
	});

	it("does not fire for a path that walks back inside through a parent segment", () => {
		// `..` is how an absolute path can look foreign and resolve inside. Comparing the text would
		// call this outside.
		expect(
			match(rule, '{"path":"/work/other/../project/packages/agent/src/turn.ts"}', { getCwd: () => CWD }),
		).toEqual([]);
	});

	/**
	 * Fails CLOSED with no working directory to compare against.
	 *
	 * The alternative — fire anyway — reproduces the exact defect the flag exists to remove, in the
	 * configuration where nobody notices: a manager built without a session (the `/omfg` rule
	 * previewer, the `ttsr` CLI) would report matches the real session would never produce.
	 */
	it("does not fire when the manager knows no working directory", () => {
		expect(match(rule, OUTSIDE)).toEqual([]);
	});

	/**
	 * Followed the advice, and the rule goes quiet. This is the property that makes the nudge
	 * actionable rather than decorative, and it only holds because the comparison happens at match
	 * time: a working directory captured when the rule was registered would keep reporting the new
	 * project as foreign forever.
	 */
	it("stops firing for a project the session has since re-rooted into", () => {
		let cwd = CWD;
		// `after-gap` with a zero gap, because the default `repeatMode: "once"` would retire the rule
		// after the first match and this test is about the SECOND one.
		const manager = new TtsrManager(
			{ enabled: true, contextMode: "discard", interruptMode: "never", repeatMode: "after-gap", repeatGap: 0 },
			{ getCwd: () => cwd },
		);
		expect(manager.addRule(rule)).toBe(true);

		manager.resetBuffer();
		expect(manager.checkDelta(OUTSIDE, { source: "tool", toolName: "read" }).map(r => r.name)).toEqual(["path-rule"]);

		cwd = "/work/other-project";
		manager.resetBuffer();
		expect(manager.checkDelta(OUTSIDE, { source: "tool", toolName: "read" })).toEqual([]);
	});
});

describe("pathScope: inside-cwd", () => {
	const rule = pathRule({ pathScope: "inside-cwd" });

	it("is the mirror image, so the check is a scope and not a hard-coded exclusion", () => {
		expect(match(rule, INSIDE, { getCwd: () => CWD })).toEqual(["path-rule"]);
		expect(match(rule, OUTSIDE, { getCwd: () => CWD })).toEqual([]);
	});

	it("also fails closed with no working directory", () => {
		expect(match(rule, INSIDE)).toEqual([]);
	});
});

describe("the matched path a scoped rule records", () => {
	/**
	 * The injected body names the directory it is advising about, and it gets that name from here.
	 * Advice to re-root that does not say WHERE leaves the model to guess, and it guesses the file's
	 * own directory rather than the project root.
	 */
	it("is the path that decided the match, not the whole matched fragment", () => {
		const manager = new TtsrManager(undefined, { getCwd: () => CWD });
		manager.addRule(pathRule({ pathScope: "outside-cwd" }));

		manager.checkDelta(OUTSIDE, { source: "tool", toolName: "read" });

		expect(manager.lastMatchedPath("path-rule")).toBe("/work/other-project/crates/cli/src/main.rs");
	});

	it("is absent for a rule that never matched", () => {
		const manager = new TtsrManager(undefined, { getCwd: () => CWD });
		manager.addRule(pathRule({ pathScope: "outside-cwd" }));

		manager.checkDelta(INSIDE, { source: "tool", toolName: "read" });

		expect(manager.lastMatchedPath("path-rule")).toBeUndefined();
	});
});
