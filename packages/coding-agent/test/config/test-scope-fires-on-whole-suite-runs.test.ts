/**
 * The test-scope rule fires on a suite with no target, and not on a narrowed run.
 *
 * WHY THIS SUITE EXISTS. Most of a session's wall clock goes to testing, and the
 * expensive variable is breadth, not frequency. Measured in this repository: one
 * test file returns in 0.31s, two package buckets in 4.8s, and 180 files in 15.0s,
 * before the sandbox's own per-invocation overhead. A narrow run after every small
 * edit is cheap and is good discipline; running everything each time is what burns
 * the session.
 *
 * Breadth is the only half a rule can see. TTSR matches the argument buffer of the
 * CURRENT tool call and carries nothing across turns, so "you have run the suite
 * four times in a row" is not expressible, while "this command names no target"
 * is. The contract is therefore: fire when a test runner is invoked with flags or
 * nothing, stay silent the moment a path, package or filter narrows it.
 *
 * The prefix deliberately admits whitespace, unlike the grep nudge next door.
 * Nothing pipes into a test runner, so there is no unobeyable case to exclude, and
 * a runner is very often invoked through a wrapper (`bash run.sh --rung=docker bun
 * test`). Requiring a command start would have made the rule silent in exactly the
 * repositories that wrap their runner, which is where it is needed.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Rule } from "../../src/capability/rule";
import { buildBuiltinRules } from "../../src/discovery/builtin-defaults";
import { TtsrManager } from "../../src/export/ttsr";

const RULE_NAME = "test-scope";

let manager: TtsrManager;
let rule: Rule;

/** True when the shipped rule fires for `command` as the bash tool's arguments. */
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
	expect(manager.addRule(rule), `${RULE_NAME} carries no reachable condition`).toBe(true);
});

describe("a suite invoked with no target", () => {
	test.each([
		["bare bun", "bun test"],
		["bun with only flags", "bun test --coverage"],
		["bun with a redirect", "bun test 2>&1"],
		["bun piped into a pager", "bun test | tail -5"],
		["npm", "npm test"],
		["a run script", "pnpm run test"],
		["yarn", "yarn test"],
		["bare cargo", "cargo test"],
		["cargo across the workspace", "cargo test --workspace"],
		["cargo with a toolchain", "cargo +nightly test --all-targets"],
		["go over every package", "go test ./..."],
		["bare pytest", "pytest"],
		["after a directory change", "cd packages/coding-agent && bun test"],
		["through a wrapper script", "bash scripts/test-sandbox/run.sh --rung=docker bun test"],
	])("nudges on %s", (_label, command) => {
		expect(nudges(command)).toBe(true);
	});
});

describe("a run that already names what it covers", () => {
	test.each([
		["a directory", "bun test packages/coding-agent/test/config"],
		["one file", "bun test packages/coding-agent/test/config/rules-have-sections.test.ts"],
		["a file plus a flag", "bun test --coverage packages/coding-agent/test/config"],
		["a cargo package", "cargo test -p veyyon-natives"],
		["a cargo filter", "cargo test identity_is_case_insensitive"],
		["a go subtree", "go test ./pkg/..."],
		["a pytest path", "pytest tests/test_identity.py"],
		["the wrapper with a path", "bash scripts/test-sandbox/run.sh --rung=docker bun test packages/tui"],
	])("stays quiet on %s", (_label, command) => {
		expect(nudges(command)).toBe(false);
	});

	test("stays quiet on a bash command that runs no test runner at all", () => {
		expect(nudges("bun run check:ts")).toBe(false);
	});
});

test("the rule is scoped to bash and does not fire on another tool's arguments", () => {
	const matched = manager.checkSnapshot("bun test", { source: "tool", toolName: "read", streamKey: "read-scope" });
	expect(matched.some(candidate => candidate.name === RULE_NAME)).toBe(false);
});

test("the body offers the narrower selection and the batching discipline, not just a refusal", () => {
	// A rule that only says "do not" leaves the model to guess the alternative, and
	// the alternative here is two separate things: narrow the run, and batch before
	// gating at all. Losing either half makes the advice unactionable.
	expect(rule.content).toContain("narrowest selection");
	expect(rule.content).toContain("Batch before you gate");
});

describe("once per compaction window", () => {
	// WHY: the rule shipped with `repeatMode: after-gap, repeatGap: 10`, which re-armed it
	// every ten completed turns inside the SAME context window, no compaction required. A
	// long window heard the same reminder five times over; the user contract is that a rule
	// injection fires at most once per compaction cycle and may speak again only in the
	// fresh window after one. The per-compact machinery already exists (`resetForCompaction`,
	// called from the session's compaction path); this pins that test-scope uses it.
	// `markInjectedByNames` stands in for the claim the session takes the moment a match is
	// bucketed, which is what suppresses the second identical call.
	test("the shipped rule repeats per compaction, not per turn gap", () => {
		expect(rule.repeatMode).toBe("per-compact");
	});

	test("the same triggering call twice injects exactly once", () => {
		expect(nudges("bun test")).toBe(true);
		manager.markInjectedByNames([RULE_NAME]);

		expect(nudges("bun test")).toBe(false);
	});

	test("turn count alone does not re-arm the rule inside one window", () => {
		expect(nudges("bun test")).toBe(true);
		manager.markInjectedByNames([RULE_NAME]);

		// Well past the old repeatGap of 10: under after-gap this fired again here.
		for (let i = 0; i < 12; i++) manager.incrementMessageCount();
		expect(nudges("bun test")).toBe(false);
	});

	test("a single compaction does not re-arm the rule, because the period is three", () => {
		// One reset used to be enough, and this rule's subject is a standing state: the
		// next suite command matches again immediately, so the reminder returned as often
		// as the transcript was replaced. The period is the rule's own declaration and is
		// swept for every bundled per-compact rule in
		// `test/ttsr/a-standing-rule-waits-out-its-period-before-repeating.test.ts`.
		expect(nudges("bun test")).toBe(true);
		manager.markInjectedByNames([RULE_NAME]);
		expect(nudges("bun test")).toBe(false);

		manager.resetForCompaction();
		expect(nudges("bun test")).toBe(false);
		manager.resetForCompaction();
		expect(nudges("bun test")).toBe(false);

		manager.resetForCompaction();
		expect(nudges("bun test")).toBe(true);

		manager.markInjectedByNames([RULE_NAME]);
		expect(nudges("bun test")).toBe(false);
	});
});
