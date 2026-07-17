/**
 * Leading global option flags must not hide a subcommand from the CLI runner.
 *
 * #2970: `omp --approval-mode=yolo acp` was rewritten to
 * `launch --approval-mode=yolo acp`, swallowing `acp` as a launch prompt so the
 * yolo override never reached the ACP command path. The resolver now skips
 * leading global flags (using the launch parser's value-consumption contract)
 * and hoists the real subcommand to the front so its parser still applies the
 * flags.
 */
import { describe, expect, test } from "bun:test";
import { resolveCliArgv } from "@veyyon/pi-coding-agent/cli-commands";

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
});
