import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import {
	flagConsumesValue,
	isUnknownLongValueCandidate,
	OPTIONAL_VALUE_FLAGS,
	STRING_VALUE_FLAGS,
} from "../src/cli/flag-tables";
import { CliUsageError } from "../src/cli/usage-error";

/**
 * Catches the set → args.ts direction of drift between
 * `cli/flag-tables.ts` and `cli/args.ts`:
 *
 * - If `STRING_VALUE_FLAGS` claims a flag consumes a value but
 *   `parseArgs` treats it as boolean (or doesn't handle it), then
 *   `<flag> --profile work` would leave `--profile` standing — and
 *   parseArgs would activate the profile branch. We assert
 *   `result.profile` is undefined: the only way that's true is if the
 *   flag actually swallowed `--profile` as its value.
 *
 * - If `OPTIONAL_VALUE_FLAGS` claims a flag releases `-`-prefixed
 *   tokens but `parseArgs` swallows them anyway, then
 *   `<flag> --profile work` would suppress the profile activation. We
 *   assert `result.profile === "work"`: the flag must NOT have eaten
 *   `--profile`, so parseArgs sees and activates it.
 *
 * The reverse direction (args.ts handler missing from the set) cannot
 * be reflected on without parsing args.ts source — it's covered by
 * per-flag regression tests in `profile-bootstrap.test.ts` and by
 * user-facing scenarios in `profile-cli.test.ts`.
 */
describe("STRING_VALUE_FLAGS table is honored by args.ts parseArgs", () => {
	for (const flag of STRING_VALUE_FLAGS) {
		it(`${flag} consumes the next token unconditionally`, () => {
			try {
				const result = parseArgs([flag, "--profile", "work"]);
				expect(
					result.profile,
					`parseArgs should treat --profile as the value of ${flag}, not as a profile activation`,
				).toBeUndefined();
			} catch (error) {
				// Value-validating flags (e.g. --max-time) reject "--profile" as their
				// value; consuming-and-rejecting still proves the flag swallowed the
				// token instead of activating the profile.
				expect(error).toBeInstanceOf(CliUsageError);
			}
		});
	}
});

describe("OPTIONAL_VALUE_FLAGS table is honored by args.ts parseArgs", () => {
	for (const flag of OPTIONAL_VALUE_FLAGS) {
		it(`${flag} releases tokens that start with -`, () => {
			const result = parseArgs([flag, "--profile", "work"]);
			expect(
				result.profile,
				`parseArgs should release --profile back to its own handler when it follows ${flag}`,
			).toBe("work");
		});
	}
});

describe("--tools legacy aliases", () => {
	it("maps search and find to grep and glob", () => {
		const result = parseArgs(["--tools", "search,find,grep"]);

		expect(result.tools).toEqual(["grep", "glob"]);
	});
});

describe("OPTIONAL_FLAGS per-flag quirks", () => {
	it("treats empty string as bare resume for --resume", () => {
		const result = parseArgs(["--resume", ""]);
		expect(result.resume).toBe(true);
		expect(result.messages).toEqual([""]);
	});

	it("treats empty string as bare resume for -r", () => {
		const result = parseArgs(["-r", ""]);
		expect(result.resume).toBe(true);
		expect(result.messages).toEqual([""]);
	});

	it("treats empty string as bare resume for --session", () => {
		const result = parseArgs(["--session", ""]);
		expect(result.resume).toBe(true);
		expect(result.messages).toEqual([""]);
	});
});

describe("parseArgs end-of-options (--)", () => {
	it("treats tokens after -- as literal messages, not flags", () => {
		const result = parseArgs(["--", "--profile", "work"]);
		expect(result.profile).toBeUndefined();
		expect(result.messages).toEqual(["--profile", "work"]);
	});

	it("does not interpret @ args or known value flags after --", () => {
		const result = parseArgs(["--", "@file.md", "--model", "opus"]);
		expect(result.model).toBeUndefined();
		expect(result.fileArgs).toEqual([]);
		expect(result.messages).toEqual(["@file.md", "--model", "opus"]);
	});

	it("parses flags before -- and forwards the rest as text", () => {
		const result = parseArgs(["--print", "hello", "--", "--no-tools"]);
		expect(result.print).toBe(true);
		expect(result.noTools).toBeUndefined();
		expect(result.messages).toEqual(["hello", "--no-tools"]);
	});
});

describe("parseArgs @file parsing with quotes", () => {
	it("parses unquoted @file arguments normally", () => {
		const result = parseArgs(["@foo.png"]);
		expect(result.fileArgs).toEqual(["foo.png"]);
	});

	it('parses double-quoted @"file" arguments', () => {
		const result = parseArgs(['@"foo bar.png"']);
		expect(result.fileArgs).toEqual(["foo bar.png"]);
	});

	it("parses single-quoted @'file' arguments", () => {
		const result = parseArgs(["@'foo bar.png'"]);
		expect(result.fileArgs).toEqual(["foo bar.png"]);
	});
});

/**
 * isUnknownLongValueCandidate and flagConsumesValue are the pure predicates that decide, during
 * the subcommand pre-scan (cli-commands.ts) and the launch parser, whether the next argv token is
 * swallowed as a flag value. They had no direct test (only the parseArgs integration around them).
 * These pin the exact value-consumption contract so a refactor of the flag tables cannot silently
 * change how many tokens a flag eats.
 */
describe("isUnknownLongValueCandidate", () => {
	it("flags only an unrecognized --long option with no inline value", () => {
		expect(isUnknownLongValueCandidate("--unknown")).toBe(true);
		expect(isUnknownLongValueCandidate("--k=v")).toBe(false); // inline value
		expect(isUnknownLongValueCandidate("-x")).toBe(false); // short flag
	});

	it("excludes every known flag (string, optional, or valueless)", () => {
		expect(isUnknownLongValueCandidate("--cwd")).toBe(false); // string-value flag
		expect(isUnknownLongValueCandidate("--resume")).toBe(false); // optional-value flag
		expect(isUnknownLongValueCandidate("--help")).toBe(false); // valueless flag
	});
});

describe("flagConsumesValue", () => {
	it("never consumes when the flag carries an inline value or there is no next token", () => {
		expect(flagConsumesValue("--foo=bar", "next")).toBe(false);
		expect(flagConsumesValue("--cwd", undefined)).toBe(false);
	});

	it("makes a known string-value flag consume any successor, even a flag-looking one", () => {
		// `--cwd --foo` => cwd is literally "--foo".
		expect(flagConsumesValue("--cwd", "--foo")).toBe(true);
		expect(flagConsumesValue("--cwd", "")).toBe(true); // string flags accept an empty value
	});

	it("makes an unknown --long flag consume only a value-like successor", () => {
		expect(flagConsumesValue("--unknown", "value")).toBe(true);
		expect(flagConsumesValue("--unknown", "--x")).toBe(false);
	});

	it("makes an optional-value flag consume a value-like non-empty successor only", () => {
		expect(flagConsumesValue("--resume", "sess-1")).toBe(true);
		expect(flagConsumesValue("--resume", "--x")).toBe(false); // flag-like
		expect(flagConsumesValue("--resume", "")).toBe(false); // rejectEmpty
	});

	it("never consumes for a valueless flag", () => {
		expect(flagConsumesValue("--help", "value")).toBe(false);
		expect(flagConsumesValue("--help", "--x")).toBe(false);
	});

	it("gates --plan (an extension-shadowable string flag) on a value-like successor only", () => {
		// Locks the fix for FINDING-FLAGCONSUMESVALUE-SHADOWABLE-BRANCH-DEAD. --plan is both a
		// STRING_SETTERS key and the sole EXTENSION_SHADOWABLE_STRING_FLAGS member; the shadowable
		// branch is now checked BEFORE the broad STRING_VALUE_FLAGS branch so `--plan opus` consumes
		// the plan name but `--plan --profile work` leaves `--profile` a fresh flag. This must match
		// profile-bootstrap's needsBoundaryAfterGlobalStrip: if these two paths ever disagree on
		// whether --plan swallows a flag-looking successor, subcommand detection and the launch parser
		// carve argv differently and a profile silently stops being selected.
		expect(flagConsumesValue("--plan", "myplan")).toBe(true);
		expect(flagConsumesValue("--plan", "--x")).toBe(false);
		expect(flagConsumesValue("--plan", "")).toBe(true); // empty is value-like (does not start with "-")
	});
});
