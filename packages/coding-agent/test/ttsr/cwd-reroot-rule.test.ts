/**
 * The shipped `cwd-reroot` rule, tested as the rule that actually ships.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT READS THE REAL FILE. `path-scope.test.ts` proves the
 * `pathScope` mechanism with a synthetic rule, and `discovery/builtin-defaults.test.ts` proves the
 * rule loads and fires. Neither pins the two frontmatter decisions that decide how much of the
 * problem this rule can see: how deep a path must be before it counts, and which tools it listens
 * to. Both are silent when wrong. The rule stays quiet, the session keeps paying absolute paths on
 * every call, and nothing anywhere reports that the advice was suppressed.
 *
 * HOW DEEP. The condition used to require four or more path segments. `/srv/app/main.rs` is three,
 * so a project laid out one level below its mount point could never fire the rule at all. Four was
 * a blunt proxy for "this points somewhere real", written before `pathScope` existed to answer that
 * question properly. With `pathScope: outside-cwd` deciding, the segment floor only has to exclude
 * the shapes that are never a file inside a project, so it is now three.
 *
 * WHICH TOOLS, AND WHY THE OBVIOUS WIDENING IS WRONG. The rule's body says the cost repeats "in
 * every edit that echoes that header back", which reads like an argument for scoping `edit` and
 * `write` in as well. It is not, and this suite records the reason so the change is not made again.
 * A TTSR condition matches the model's OUTPUT STREAM. For a navigation call that stream is the
 * target path, so a match is the thing being reached for. For an edit or a write the stream is the
 * file CONTENT, and content mentions absolute paths constantly: a doc, a config, a fixture, a path
 * constant. Scoping those tools in would fire the nudge on where a file TALKS about rather than
 * where it LIVES, and would advise re-rooting into a directory the session never touched. The
 * write side is covered instead by `RerootDetector` in `src/tools/reroot-hint.ts`, which observes
 * each tool's declared `filesystemTargets` and so sees where the edit actually lands.
 */

import { describe, expect, it } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { BUILTIN_RULE_SOURCES } from "@veyyon/coding-agent/discovery/builtin-rules/index";
import { buildRuleFromMarkdown, createSourceMeta } from "@veyyon/coding-agent/discovery/helpers";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";

const CWD = "/work/project";
const RULE_PATH = "/builtin/cwd-reroot.md";

/**
 * The bundled rule, parsed the way the loader parses it.
 *
 * Read from `BUILTIN_RULE_SOURCES` rather than restated here, because a copy of the frontmatter in
 * this file would keep passing after the shipped rule changed, which is the one failure this suite
 * exists to catch.
 */
function rerootRule(): Rule {
	const source = BUILTIN_RULE_SOURCES.find(entry => entry.name === "cwd-reroot");
	if (!source) throw new Error("the cwd-reroot builtin rule is not registered");
	return buildRuleFromMarkdown(
		"cwd-reroot.md",
		source.content,
		RULE_PATH,
		createSourceMeta("builtin", RULE_PATH, "project"),
		{ stripNamePattern: /\.(md|mdc)$/ },
	);
}

/**
 * Fire one tool delta through a fresh manager and report whether the rule matched.
 *
 * A fresh manager per call because a rule that has fired is subject to its repeat policy, and each
 * case here asks an independent question about the first firing.
 */
function fires(delta: string, toolName: string, cwd = CWD): boolean {
	const manager = new TtsrManager(undefined, { getCwd: () => cwd });
	expect(manager.addRule(rerootRule())).toBe(true);
	return manager.checkDelta(delta, { source: "tool", toolName }).some(r => r.name === "cwd-reroot");
}

const OUTSIDE = '{"path":"/work/other-project/crates/cli/src/main.rs"}';

describe("how deep a path has to be before it counts", () => {
	/**
	 * THE regression. Three segments is an ordinary project file and the case the four-segment floor
	 * excluded outright. `/srv/app/main.rs` is a real layout, and under the old condition a session
	 * working there was never once advised to re-root, with nothing reporting the silence.
	 */
	it("fires for a three-segment project path", () => {
		expect(fires('{"path":"/srv/app/main.rs"}', "read")).toBe(true);
	});

	/** Deeper paths were the only ones that ever worked, and must keep working. */
	it("still fires for a deep path", () => {
		expect(fires(OUTSIDE, "read")).toBe(true);
	});

	/**
	 * Two segments is `/work/project`, `/home/someone`, `/mnt/data`: a directory, not a file inside
	 * one. A model names its own working directory in prose constantly, so a floor low enough to
	 * match a bare directory would fire on the session describing where it already is.
	 */
	it.each(["/home/someone", "/mnt/data", "/work/elsewhere"])(
		"stays silent for %s, which names a directory rather than a file in one",
		directory => {
			expect(fires(`{"path":"${directory}"}`, "read")).toBe(false);
		},
	);

	/**
	 * The system-directory exclusions survive the relaxed floor, and this is the case the relaxation
	 * put at risk. Three segments now qualifies on depth, so `/usr/share/thing` reaches the negative
	 * lookahead for the first time. Without it the rule would advise re-rooting into the operating
	 * system, which is advice that cannot be taken: reading a toolchain header or a temp file is
	 * ordinary work, not a project move.
	 */
	it.each([
		"/usr/share/thing",
		"/etc/systemd/system",
		"/var/log/app",
		"/tmp/build/out",
		"/opt/tool/bin",
		"/proc/self/status",
		"/Library/Frameworks/Thing",
	])("stays silent for the system path %s", systemPath => {
		expect(fires(`{"path":"${systemPath}"}`, "read")).toBe(false);
	});
});

describe("the tools cwd-reroot listens to", () => {
	/**
	 * The navigation tools, where the path in the stream IS the thing being reached for. This is the
	 * whole set the rule can safely read, and it is pinned so a scope rewrite cannot drop one: a
	 * missing tool here is a class of cross-project work the rule stops seeing, silently.
	 */
	it.each(["read", "grep", "glob", "ast_grep"])("fires for the navigation tool %s", toolName => {
		expect(fires(OUTSIDE, toolName)).toBe(true);
	});

	/**
	 * The deliberate exclusion, stated as an assertion so it survives the next reading of the rule's
	 * body. An edit's stream is file content, and content that MENTIONS a foreign path is not work
	 * happening at that path. Firing here would advise a move to a directory the session never
	 * touched, on the evidence of a string in a file.
	 */
	it.each(["edit", "write", "ast_edit"])("stays silent for %s, whose stream carries content", toolName => {
		expect(fires(OUTSIDE, toolName)).toBe(false);
	});

	/**
	 * `bash` is excluded for the same reason: a command line quotes paths that are arguments, but a
	 * heredoc or an `echo` embeds content just as an edit does, and nothing in a regex over the
	 * stream can tell the two apart. Bash reaches the re-root advice by the other route, through the
	 * explicit `cwd` argument that `RerootDetector.observe` reads.
	 */
	it("stays silent for bash, which reaches the advice through the detector instead", () => {
		expect(fires('{"command":"cargo test --manifest-path /work/other-project/Cargo.toml"}', "bash")).toBe(false);
	});

	/** A tool named nowhere in the scope must not fire, or the scope field is decoration. */
	it("stays silent for a tool outside its scope entirely", () => {
		expect(fires(OUTSIDE, "todo")).toBe(false);
	});
});

describe("the rule's own frontmatter", () => {
	/**
	 * `pathScope` is what makes the relaxed segment floor safe: with the floor at three, far more
	 * in-cwd paths now match the condition, and only this flag keeps them from firing. Dropping it
	 * would turn the relaxation into the false-positive storm the flag was added to end, so it is
	 * pinned rather than assumed.
	 */
	it("keeps the outside-cwd path scope the segment floor depends on", () => {
		expect(rerootRule().pathScope).toBe("outside-cwd");
	});

	/** The in-cwd case the flag exists for, asserted at the new floor rather than the old one. */
	it("does not fire for a three-segment path inside the working directory", () => {
		expect(fires('{"path":"/work/project/main.rs"}', "read")).toBe(false);
	});

	/**
	 * Advice that interrupts the model mid-thought to discuss path length is not worth the
	 * interruption, and a nudge that repeats trains the model to skim past the channel it arrives
	 * on. Both are pinned because both are policy the rule chose, not defaults it inherited.
	 */
	it("never interrupts and leaves a gap before repeating", () => {
		const rule = rerootRule();

		expect(rule.interruptMode).toBe("never");
		expect(rule.repeatMode).toBe("after-gap");
		expect(rule.repeatGap).toBe(8);
	});
});
