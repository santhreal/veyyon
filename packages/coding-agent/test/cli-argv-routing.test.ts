/**
 * Leading global option flags must not hide a subcommand from the CLI runner.
 *
 * #2970: `veyyon --approval-mode=yolo acp` was rewritten to
 * `launch --approval-mode=yolo acp`, swallowing `acp` as a launch prompt so the
 * yolo override never reached the ACP command path. The resolver now skips
 * leading global flags (using the launch parser's value-consumption contract)
 * and hoists the real subcommand to the front so its parser still applies the
 * flags.
 */
import { describe, expect, test } from "bun:test";
import { resolveCliArgv } from "@veyyon/coding-agent/cli-commands";

describe("resolveCliArgv routes subcommands hidden behind leading global flags", () => {
	test("`--approval-mode=yolo acp` dispatches the acp subcommand with the flag preserved", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "acp"])).toEqual({
			argv: ["acp", "--approval-mode=yolo"],
		});
	});

	test("space-form `--approval-mode yolo acp` keeps the flag and its value with acp", () => {
		expect(resolveCliArgv(["--approval-mode", "yolo", "acp"])).toEqual({
			argv: ["acp", "--approval-mode", "yolo"],
		});
	});

	test("multiple leading flags before the subcommand are all preserved", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "--model", "gpt", "acp"])).toEqual({
			argv: ["acp", "--approval-mode=yolo", "--model", "gpt"],
		});
	});

	test("a value-consuming flag does not mistake its value for a subcommand", () => {
		// `acp` here is the value of `--model`, not the subcommand, so this stays a
		// launch prompt exactly as the launch parser would read it.
		expect(resolveCliArgv(["--model", "acp"])).toEqual({
			argv: ["launch", "--model", "acp"],
		});
	});

	test("`--` ends option scanning so a following subcommand stays a launch prompt", () => {
		expect(resolveCliArgv(["--", "acp"])).toEqual({
			argv: ["launch", "--", "acp"],
		});
	});

	test("a genuine launch prompt is untouched", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "fix", "the", "bug"])).toEqual({
			argv: ["launch", "--approval-mode=yolo", "fix", "the", "bug"],
		});
	});

	test("a subcommand already in front still passes through unchanged", () => {
		expect(resolveCliArgv(["acp", "--approval-mode=yolo"])).toEqual({
			argv: ["acp", "--approval-mode=yolo"],
		});
	});

	test("`gc` dispatches as a top-level maintenance subcommand", () => {
		expect(resolveCliArgv(["gc", "--apply"])).toEqual({
			argv: ["gc", "--apply"],
		});
	});

	test("--plan does not swallow a following flag, so its value-consuming successor keeps its own value", () => {
		// Regression for FINDING-FLAGCONSUMESVALUE-SHADOWABLE-BRANCH-DEAD. --plan is
		// extension-shadowable: a flag-looking successor stays a fresh flag. Before the fix,
		// flagConsumesValue matched --plan on the broad STRING_VALUE_FLAGS branch first and had
		// it consume `--model`, exposing `acp` as a bare token that leadingSubcommandIndex then
		// hoisted to the acp SUBCOMMAND. The correct reading: `--model acp` means model `acp`,
		// so the whole thing is a launch prompt. This proves flagConsumesValue and the routing
		// scanner agree with the documented shadowable contract.
		expect(resolveCliArgv(["--plan", "--model", "acp"])).toEqual({
			argv: ["launch", "--plan", "--model", "acp"],
		});
	});

	test("--plan still consumes a value-like successor, so a subcommand-named plan is not a subcommand", () => {
		// The value-like half of the same contract: `--plan acp` names a plan `acp`; `acp` must
		// NOT be routed to the acp subcommand. flagConsumesValue returns true for the value-like
		// successor, so the scanner skips it and the invocation forwards to launch.
		expect(resolveCliArgv(["--plan", "acp"])).toEqual({
			argv: ["launch", "--plan", "acp"],
		});
	});
});

describe("resolveCliArgv near-miss did-you-mean (bare single token)", () => {
	test("`auth` (prefix of auth-broker/auth-gateway) errors with suggestions and the prompt escape", () => {
		const resolved = resolveCliArgv(["auth"]);
		if (!("error" in resolved)) throw new Error(`expected error, got argv ${JSON.stringify(resolved.argv)}`);
		expect(resolved.error).toContain("`veyyon auth` is not a command");
		expect(resolved.error).toContain("veyyon auth-broker");
		expect(resolved.error).toContain("veyyon launch auth");
	});

	test("`stat` (typo/prefix of stats) errors with the stats suggestion", () => {
		const resolved = resolveCliArgv(["stat"]);
		if (!("error" in resolved)) throw new Error(`expected error, got argv ${JSON.stringify(resolved.argv)}`);
		expect(resolved.error).toContain("veyyon stats");
	});

	test("a bare token nowhere near any command still forwards to launch", () => {
		expect(resolveCliArgv(["xylophone"])).toEqual({
			argv: ["launch", "xylophone"],
		});
	});

	test("multi-word invocations never trigger the near-miss error (genuine prompts win)", () => {
		expect(resolveCliArgv(["auth", "list"])).toEqual({
			argv: ["launch", "auth", "list"],
		});
	});

	test("flags and @file args are never near-miss candidates", () => {
		expect(resolveCliArgv(["@stats.txt"])).toEqual({
			argv: ["launch", "@stats.txt"],
		});
	});

	test("a near-miss token with only flags attached still errors (`updte --print` leak)", () => {
		const resolved = resolveCliArgv(["updte", "--print"]);
		if (!("error" in resolved)) throw new Error(`expected error, got argv ${JSON.stringify(resolved.argv)}`);
		expect(resolved.error).toContain("`veyyon updte` is not a command");
		expect(resolved.error).toContain("veyyon update");
	});

	test("flag order does not matter: `--print updte` errors the same way", () => {
		const resolved = resolveCliArgv(["--print", "updte"]);
		if (!("error" in resolved)) throw new Error(`expected error, got argv ${JSON.stringify(resolved.argv)}`);
		expect(resolved.error).toContain("veyyon update");
	});

	test("a near-miss token plus a second positional stays a genuine prompt", () => {
		expect(resolveCliArgv(["updte", "everything"])).toEqual({
			argv: ["launch", "updte", "everything"],
		});
	});

	test("a near-miss token plus an @file arg stays a genuine prompt", () => {
		expect(resolveCliArgv(["updte", "@notes.md"])).toEqual({
			argv: ["launch", "updte", "@notes.md"],
		});
	});

	test("`-- updte` (explicit end-of-options) is always a prompt", () => {
		expect(resolveCliArgv(["--", "updte"])).toEqual({
			argv: ["launch", "--", "updte"],
		});
	});

	test("a value-consuming flag's value is not the sole positional", () => {
		// `stat` is --model's value, so nothing near-miss fires and this stays a prompt-less launch.
		expect(resolveCliArgv(["--model", "stat"])).toEqual({
			argv: ["launch", "--model", "stat"],
		});
	});

	test("a genuine one-word prompt does not false-positive on a distance-2 command", () => {
		// "hello" is 2 edits from "shell"; short tokens only match at distance 1,
		// so `veyyon -p hello` must stay a prompt.
		expect(resolveCliArgv(["--print", "hello"])).toEqual({
			argv: ["launch", "--print", "hello"],
		});
		expect(resolveCliArgv(["hello"])).toEqual({
			argv: ["launch", "hello"],
		});
	});
});
