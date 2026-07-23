import { describe, expect, it } from "bun:test";
import { parseArgs, reportUnrecognizedFlags } from "@veyyon/coding-agent/cli/args";

/**
 * Operator-facing CLI parse contracts: unknown flags are recorded (issue #2459)
 * and reported loud; help/version/print modes set exact fields.
 */

describe("CLI operator contracts (parseArgs)", () => {
	it("records unknown long flags without consuming them as the prompt", () => {
		const parsed = parseArgs(["--definitely-not-a-real-flag-xyz"]);
		expect(parsed.unrecognizedFlags).toEqual(["--definitely-not-a-real-flag-xyz"]);
		expect(parsed.messages).toEqual([]);
	});

	it("sets help and version booleans", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["--version"]).version).toBe(true);
	});

	it("parses --print with a prompt string", () => {
		const args = parseArgs(["--print", "hello operator"]);
		expect(args.print).toBe(true);
		expect(args.messages).toEqual(["hello operator"]);
		expect(args.unrecognizedFlags).toEqual([]);
	});

	it("parses empty argv into defaults with no messages and no unknown flags", () => {
		const args = parseArgs([]);
		expect(args.messages).toEqual([]);
		expect(args.unrecognizedFlags).toEqual([]);
		expect(args.help).toBeFalsy();
		expect(args.print).toBeFalsy();
	});

	it("reportUnrecognizedFlags returns true when unknowns remain", () => {
		const parsed = parseArgs(["--list-models"]);
		// reportUnrecognizedFlags writes to stderr and returns whether it reported.
		const reported = reportUnrecognizedFlags(parsed);
		expect(parsed.unrecognizedFlags).toEqual(["--list-models"]);
		expect(reported).toBe(true);
	});

	it("reportUnrecognizedFlags returns false when the parse is clean", () => {
		const parsed = parseArgs(["--print", "hi"]);
		expect(reportUnrecognizedFlags(parsed)).toBe(false);
	});

	it("sets autoApprove for both --yolo and --auto-approve", () => {
		expect(parseArgs(["--yolo"]).autoApprove).toBe(true);
		expect(parseArgs(["--auto-approve"]).autoApprove).toBe(true);
		expect(parseArgs([]).autoApprove).toBeFalsy();
	});

	it("sets dangerouslySkipPermissions only for the stronger bypass flag", () => {
		expect(parseArgs(["--dangerously-skip-permissions"]).dangerouslySkipPermissions).toBe(true);
		expect(parseArgs(["--yolo"]).dangerouslySkipPermissions).toBeFalsy();
	});

	it("parses --cwd and --model string values exactly", () => {
		const cwd = parseArgs(["--cwd", "/tmp/operator-cwd"]);
		expect(cwd.cwd).toBe("/tmp/operator-cwd");
		expect(cwd.unrecognizedFlags).toEqual([]);
		const model = parseArgs(["--model", "google-antigravity/gemini-3.6-flash"]);
		expect(model.model).toBe("google-antigravity/gemini-3.6-flash");
		expect(model.unrecognizedFlags).toEqual([]);
	});

	it("parses --profile space and equals forms", () => {
		expect(parseArgs(["--profile", "work"]).profile).toBe("work");
		expect(parseArgs(["--profile=lab"]).profile).toBe("lab");
	});

	it("parses --no-session and --allow-home booleans", () => {
		expect(parseArgs(["--no-session"]).noSession).toBe(true);
		expect(parseArgs(["--allow-home"]).allowHome).toBe(true);
		expect(parseArgs([]).noSession).toBeFalsy();
		expect(parseArgs([]).allowHome).toBeFalsy();
	});

	it("keeps known flags out of unrecognizedFlags while recording true unknowns", () => {
		const clean = parseArgs(["--print", "hi", "--yolo", "--cwd", "/tmp/x"]);
		expect(clean.unrecognizedFlags).toEqual([]);
		expect(clean.print).toBe(true);
		expect(clean.autoApprove).toBe(true);
		expect(clean.cwd).toBe("/tmp/x");
		expect(clean.messages).toEqual(["hi"]);

		const mixed = parseArgs(["--yolo", "--not-a-real-veyyon-flag", "--print", "x"]);
		expect(mixed.autoApprove).toBe(true);
		expect(mixed.print).toBe(true);
		expect(mixed.messages).toEqual(["x"]);
		expect(mixed.unrecognizedFlags).toEqual(["--not-a-real-veyyon-flag"]);
	});

	it("treats arguments after -- as positional messages even when flag-shaped", () => {
		const parsed = parseArgs(["--print", "before", "--", "--yolo", "--help"]);
		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["before", "--yolo", "--help"]);
		expect(parsed.autoApprove).toBeFalsy();
		expect(parsed.help).toBeFalsy();
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	it("maps short -p/-h/-v to print/help/version", () => {
		expect(parseArgs(["-p", "hi"]).print).toBe(true);
		expect(parseArgs(["-p", "hi"]).messages).toEqual(["hi"]);
		expect(parseArgs(["-h"]).help).toBe(true);
		expect(parseArgs(["-v"]).version).toBe(true);
		expect(parseArgs(["-h"]).unrecognizedFlags).toEqual([]);
	});

	it("sets thinking/plan/alias operator flags exactly", () => {
		expect(parseArgs(["--hide-thinking"]).hideThinking).toBe(true);
		expect(parseArgs(["--print-thoughts"]).printThoughts).toBe(true);
		expect(parseArgs(["--plan-yolo"]).planYolo).toBe(true);
		expect(parseArgs(["--alias", "lab"]).alias).toBe("lab");
		expect(parseArgs(["--alias=lab"]).alias).toBe("lab");
		expect(parseArgs([]).hideThinking).toBeFalsy();
		expect(parseArgs([]).planYolo).toBeFalsy();
	});

	it("sets no-* disable flags without recording them as unknown", () => {
		const parsed = parseArgs([
			"--no-tools",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-extensions",
			"--no-pty",
			"--no-title",
			"--no-prewalk",
		]);
		expect(parsed.noTools).toBe(true);
		expect(parsed.noSkills).toBe(true);
		expect(parsed.noRules).toBe(true);
		expect(parsed.noLsp).toBe(true);
		expect(parsed.noExtensions).toBe(true);
		expect(parsed.noPty).toBe(true);
		expect(parsed.noTitle).toBe(true);
		expect(parsed.noPrewalk).toBe(true);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	it("treats --advisor as a boolean and leaves a following token as a message", () => {
		expect(parseArgs(["--advisor"]).advisor).toBe(true);
		expect(parseArgs(["--advisor"]).messages).toEqual([]);
		const withToken = parseArgs(["--advisor", "devin"]);
		expect(withToken.advisor).toBe(true);
		expect(withToken.messages).toEqual(["devin"]);
		expect(withToken.unrecognizedFlags).toEqual([]);
	});

	it("records short unknown flags as unrecognized without consuming the next token", () => {
		const parsed = parseArgs(["--print", "x", "--not-real-shortish"]);
		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["x"]);
		expect(parsed.unrecognizedFlags).toEqual(["--not-real-shortish"]);
	});
});
