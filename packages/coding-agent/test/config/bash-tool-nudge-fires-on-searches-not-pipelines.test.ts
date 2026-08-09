/**
 * The bash-tool-nudge fires on a search it can replace, and stays quiet on a pipe.
 *
 * WHY THIS SUITE EXISTS. The rule tells the model to reach for the built-in
 * `grep`/`glob` tools instead of shelling out. Its condition used to admit a bare
 * `\s` before the tool name, which is also the space after a pipe, so
 * `bun run check:types | grep -E "error TS"` tripped it. That advice cannot be
 * obeyed: the built-in tools take a path or a glob and cannot read another
 * command's stdout, so there is nothing to switch to. A rule that fires where it
 * cannot be obeyed is worse than no rule, because the model learns to ignore it
 * and then ignores it on the searches it should have caught.
 *
 * The contract is therefore positional, not lexical: the nudge fires when a search
 * tool STARTS a command (line start, `&&`, `||`, `;`, or a command substitution),
 * and stays silent when the same tool only consumes a pipeline. Both halves are
 * load-bearing, so both are tested, and the tests drive the shipped rule through
 * the real `TtsrManager` funnel rather than re-deriving the regex, because what is
 * promised is that the rule fires, not that a pattern exists in frontmatter.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Rule } from "../../src/capability/rule";
import { buildBuiltinRules } from "../../src/discovery/builtin-defaults";
import { TtsrManager } from "../../src/export/ttsr";

const RULE_NAME = "bash-tool-nudge";

let manager: TtsrManager;
let rule: Rule;

/** True when the shipped nudge fires for `command` as the bash tool's arguments. */
function nudges(command: string): boolean {
	const matched = manager.checkSnapshot(command, { source: "tool", toolName: "bash", streamKey: command });
	return matched.some(candidate => candidate.name === RULE_NAME);
}

beforeEach(() => {
	const found = buildBuiltinRules().find(candidate => candidate.name === RULE_NAME);
	expect(found, `${RULE_NAME} is no longer a bundled rule`).toBeDefined();
	rule = found as Rule;
	manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
	});
	// A rule the manager refused to register would make every silence below vacuous.
	expect(manager.addRule(rule), `${RULE_NAME} carries no TTSR condition`).toBe(true);
});

describe("commands the built-in tools can replace", () => {
	test.each([
		["a bare search", 'grep -rn "foo" src'],
		["ripgrep", "rg foo packages"],
		["find", "find . -name '*.ts'"],
		["after &&", "cd packages && grep -n foo src"],
		["after ||", "test -d src || find . -maxdepth 1"],
		["after ;", "true; find . -type f"],
		["inside a command substitution", "echo $(grep -c foo file)"],
		["a search whose output is then paged", "grep -n foo src | head -5"],
		["on a later line", "cd packages\nrg foo src"],
		[
			"a search that opens a later command after an unrelated pipeline",
			'ls target/ 2>/dev/null | head -5; echo "==="; find target/ -name ".cargo-lock" 2>/dev/null | head -5',
		],
	])("nudges on %s", (_label, command) => {
		expect(nudges(command)).toBe(true);
	});
});

describe("commands the built-in tools cannot replace", () => {
	test.each([
		["the type-check filter that first misfired", 'bun run check:types 2>&1 | grep -E "error TS"'],
		["porcelain status filtering", "git status --porcelain | grep '^ M'"],
		["ripgrep over a command's output", "cargo test | rg failed"],
		["a multi-stage pipeline", "bun test 2>&1 | grep -c pass | head -1"],
		["no whitespace around the pipe", "bun test|grep pass"],
		[
			"a sandboxed test run whose filter pattern itself contains an anchor character",
			'bash scripts/test-sandbox/run.sh --rung=docker bun test ./pkg 2>&1 | grep -E "^\\s*\\(fail\\)|Expected:"',
		],
	])("stays quiet on %s", (_label, command) => {
		expect(nudges(command)).toBe(false);
	});

	test("stays quiet on a bash command that runs no search tool at all", () => {
		expect(nudges("bun test packages/coding-agent")).toBe(false);
	});
});

/**
 * A pipe is not the only way a search tool ends up reading stdin. A heredoc or a
 * herestring feeds it text that lives in the shell, and the tool then STARTS the
 * command, so the positional rule alone would fire on it. There is still no path
 * to hand the built-in tools, so the advice is still unobeyable. A single `<`
 * redirect is the opposite case: that operand is a file on disk, which is exactly
 * what the built-in grep wants, so the nudge belongs there.
 */
describe("stdin fed by a redirect rather than a pipe", () => {
	test.each([
		["a herestring", 'grep -q "^ok" <<<"$output"'],
		["a herestring after &&", 'bun test && grep -c fail <<<"$log"'],
		["a heredoc", "grep -n needle <<EOF\nhaystack\nEOF"],
		["ripgrep over a herestring", 'rg "error" <<<"$out"'],
	])("stays quiet on %s", (_label, command) => {
		expect(nudges(command)).toBe(false);
	});

	test.each([
		["a plain file redirect", "grep -c error < build.log"],
		["a file argument alongside a later pipe", "grep -n foo src/main.ts | head -3"],
	])("still nudges on %s", (_label, command) => {
		expect(nudges(command)).toBe(true);
	});

	/** The suppression is scoped to the segment: a later command that really is a
	 *  file search still gets caught. */
	test("nudges on a file search that follows a herestring search", () => {
		expect(nudges('grep -q ok <<<"$out"; grep -rn foo src')).toBe(true);
	});
});

test("the nudge is scoped to bash and does not fire on another tool's arguments", () => {
	const matched = manager.checkSnapshot('grep -rn "foo" src', {
		source: "tool",
		toolName: "read",
		streamKey: "read-scope",
	});
	expect(matched.some(candidate => candidate.name === RULE_NAME)).toBe(false);
});

test("the body names the stdin limit that makes a pipeline the exception", () => {
	// The positional condition decides WHEN it fires; the body has to explain why a
	// pipe is different, or the model generalises the nudge back over pipelines.
	expect(rule.content).toContain("cannot read stdin");
});

/**
 * The banner an operator reads is the rule's `description`, and it has to describe the
 * condition above it. It said the nudge fires when a bash command "starts with" a search
 * tool, while the condition fires on any command the call opens with one, so a call that
 * began with `ls` and ran `find` in its third command produced a banner that contradicted
 * the command beside it. A rule whose banner reads as a misfire is ignored on the searches
 * it should catch, which is the same failure the positional condition was written to avoid.
 */
test("the description does not promise a narrower trigger than the condition fires on", () => {
	const description = rule.description ?? "";
	expect(description).not.toContain("starts with");
	// The claim is only worth making if the wider case really is live.
	expect(nudges('ls target/ | head -5; find target/ -name "*.lock"')).toBe(true);
});
