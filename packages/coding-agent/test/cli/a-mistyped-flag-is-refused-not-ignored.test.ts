/**
 * A flag the user got wrong must be refused out loud, never silently dropped.
 *
 * WHY THIS SUITE EXISTS. Two ways to mistype a flag, one of which was silent, and the silent one was
 * the dangerous one.
 *
 * THE SILENT DROP. A value-taking flag in the last argv position fell through every branch of the
 * parse loop and vanished. `veyyon -p "..." --approval-mode` exited 0, answered normally, and ran on
 * the DEFAULT approval mode: the operator asked for one approval policy, silently got another, and
 * the only evidence they had that the flag took effect was that they had typed it. There is no typo
 * to notice here, which is what makes it worse than a misspelling. It applied to every string-valued
 * flag, including `--model`, so a session could quietly run on the wrong model too.
 *
 * THE UNHELPFUL REFUSAL. A misspelled flag was rejected, correctly, with "unknown flag: --modle" and
 * nothing else, while a misspelled SUBCOMMAND one keystroke away already answered "Did you mean
 * `veyyon config`?". Both reject the same class of mistake, so leaving the reader to diff their typo
 * against a list of fifty-seven flags was a gap rather than a decision.
 *
 * WHAT IS DELIBERATELY NOT REFUSED is the profile bootstrap's boundary sentinel, which has its own
 * pinned behaviour in profile-bootstrap.test.ts: there the flag is skipped so the user's trailing
 * message survives, and refusing would drop the message in order to report the flag. That row is
 * here too, because the boundary between "no value at all" and "a value the bootstrap removed" is
 * exactly what a future edit to this branch would blur.
 */
import { describe, expect, it } from "bun:test";
import { parseArgs, reportUnrecognizedFlags } from "@veyyon/coding-agent/cli/args";
import { PROFILE_BOOTSTRAP_BOUNDARY_ARG } from "@veyyon/coding-agent/cli/flag-tables";
import { CliUsageError } from "@veyyon/coding-agent/cli/usage-error";

/** Collect what the reporter writes instead of letting it reach the real stderr. */
function report(flags: string[]): string {
	let text = "";
	reportUnrecognizedFlags({ unrecognizedFlags: flags }, chunk => {
		text += chunk;
	});
	return text;
}

describe("a value-taking flag given no value", () => {
	/**
	 * The headline case, and the exact command that exposed it. `--approval-mode` decides whether
	 * tool calls are prompted for, so silently running on the default is a safety question rather
	 * than a cosmetic one.
	 */
	it("is refused rather than dropped when it is the last argument", () => {
		expect(() => parseArgs(["-p", "say hi", "--approval-mode"])).toThrow(CliUsageError);
	});

	/** The refusal has to say which flag and what to type, or it just relocates the confusion. */
	it("names the flag and both accepted spellings", () => {
		let message = "";
		try {
			parseArgs(["--model"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("--model");
		expect(message).toContain("--model <value>");
		expect(message).toContain("--model=<value>");
	});

	/**
	 * Not one flag with a special case. The drop was structural, in the branch every string-valued
	 * flag shares, so each of these was silently ignorable in the same position.
	 */
	for (const flag of ["--model", "--approval-mode", "--thinking", "--system-prompt", "--session-dir"]) {
		it(`refuses a bare trailing ${flag}`, () => {
			expect(() => parseArgs([flag])).toThrow(CliUsageError);
		});
	}

	/** A flag that DID get its value must still parse, or the guard has eaten the normal path. */
	it("still accepts the flag when a value follows", () => {
		expect(parseArgs(["--model", "opus"]).model).toBe("opus");
		expect(parseArgs(["--model=opus"]).model).toBe("opus");
	});

	/**
	 * The deliberate exception. The bootstrap removed `--profile work` and left its marker, so the
	 * flag has no value, but refusing would discard the message the user is waiting on. Skipping is
	 * the pinned behaviour; this row exists so the exception stays a decision rather than a leak.
	 */
	it("skips rather than refuses when the profile bootstrap removed the value", () => {
		const parsed = parseArgs(["--plan", PROFILE_BOOTSTRAP_BOUNDARY_ARG, "follow up"]);

		expect(parsed.plan).toBeUndefined();
		expect(parsed.messages).toEqual(["follow up"]);
	});
});

describe("an unrecognized flag", () => {
	/** The suggestion is the point: a typo one edit away should be named, not searched for. */
	it("suggests the flag the user probably meant", () => {
		const text = report(["--modle"]);

		expect(text).toContain("--modle");
		expect(text).toContain("Did you mean");
		expect(text).toContain("--model");
	});

	/** A transposition is the most common typo, and the metric behind nearestNames handles it. */
	it("suggests across a transposition", () => {
		expect(report(["--prewalk-itno"])).toContain("--prewalk-into");
	});

	/**
	 * A suggestion must never invent a flag. Every name offered has to be one the parser accepts,
	 * which is why the candidates come from the parser's own tables rather than a second list: a
	 * hand-written list of suggestions drifts the first time a flag is added or renamed, and then
	 * the error confidently recommends something that does not exist.
	 */
	it("only ever suggests flags the parser recognizes", () => {
		const text = report(["--modle"]);
		const suggested = [...text.matchAll(/`(--[a-z-]+)`/g)].map(match => match[1] ?? "");

		expect(suggested.length).toBeGreaterThan(0);
		for (const flag of suggested) {
			try {
				expect(parseArgs([flag, "placeholder"]).unrecognizedFlags).not.toContain(flag);
			} catch (error) {
				// A usage error is RECOGNITION, not a miss: the flag was found, and got far enough to
				// judge its value (`--mode` refuses "placeholder" by listing its accepted values).
				// Only an unrecognized flag would have been silently collected instead.
				expect(error).toBeInstanceOf(CliUsageError);
				expect((error as CliUsageError).message).toContain(flag);
			}
		}
	});

	/** Nothing close enough is silence, not a wild guess: a wrong suggestion is worse than none. */
	it("offers nothing when the typo resembles no flag", () => {
		const text = report(["--zzzzzzzzqqqq"]);

		expect(text).toContain("--zzzzzzzzqqqq");
		expect(text).not.toContain("Did you mean");
		// It still points somewhere useful.
		expect(text).toContain("--help");
	});

	/** Several typos at once each get their own answer rather than one merged guess. */
	it("answers each unknown flag separately", () => {
		const text = report(["--modle", "--thinkng"]);

		expect(text).toContain("--model");
		expect(text).toContain("--thinking");
	});

	/** No unknown flags means no output and no false alarm. */
	it("reports nothing when every flag was recognized", () => {
		let wrote = false;
		const had = reportUnrecognizedFlags({ unrecognizedFlags: [] }, () => {
			wrote = true;
		});

		expect(had).toBe(false);
		expect(wrote).toBe(false);
	});
});
