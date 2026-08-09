/**
 * No `/secret` refusal repeats the bytes it refused.
 *
 * WHY THIS SUITE EXISTS. `/secret` is the one command whose argument line is a credential, so every
 * refusal it writes is a candidate leak. A refusal lands in the scrollback, in the saved transcript,
 * and on the noninteractive surface in whatever the client logs, and none of those are places the
 * operator can take a credential back out of. The realistic slip is muscle memory: `/secret extend
 * TOKEN sk-live-...`, `/secret rm TOKEN sk-live-...`, a value appended to a bare `/secret list`, or
 * a client that types `/secret ghp_...` on a surface with no field to hide it in. Every one of those
 * lands in a parser refusal.
 *
 * It has already regressed twice in opposite directions. `--limit` quoted the word it could not read
 * for every verb but `add`, and an unknown-subcommand refusal was briefly made to name the word it
 * did not recognise, which on a noninteractive surface is most often the credential itself.
 *
 * SO THE CASES ARE DERIVED. Every slot below is generated from `SECRET_SUBCOMMAND_SHAPES`: the extra
 * bare word for each verb that reads a bounded number of them, and each validated option value for
 * the verbs that declare that option. A new verb is covered the moment it is declared, and a new
 * option turns this suite red until it is classified as validated or free-form.
 *
 * WHAT IT DOES NOT CATCH. Two echoes are deliberate and are excluded by name rather than removed.
 * An option-shaped word is repeated by `Unknown option "--x"`, because a credential does not begin
 * with `--` and `add` refuses an ambiguous inline value before that branch is reachable. A stored
 * NAME is repeated by the runner, because a name is not a secret and the operator needs to know
 * which one was not found. This suite covers the parser, which is where a line's bytes are still
 * arbitrary; the runner only ever sees a name it has already normalised.
 */
import { describe, expect, it } from "bun:test";
import {
	parseSecretCommand,
	SECRET_SUBCOMMAND_SHAPES,
	type SecretCommandSurface,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";

/**
 * A credential shaped like the ones people actually paste, and long enough to be worth protecting.
 *
 * Mixed case on purpose: a refusal that lowercases or uppercases what it echoes is still an echo,
 * so every assertion compares case-insensitively and a normalised leak is caught too.
 */
const SENTINEL = "ghp_LiveSentinelBytes0123456789";

const VERBS = Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[];
const SURFACES: readonly SecretCommandSurface[] = ["tui", "noninteractive"];
const EVERY_OPTION = [...new Set(VERBS.flatMap(verb => SECRET_SUBCOMMAND_SHAPES[verb].options))].sort();

/**
 * The options whose value belongs to a validated domain, and the sentence each refusal must carry.
 *
 * `--ttl` names the shape it wanted rather than the option, because the operator's mistake is the
 * lifetime and not the flag. Pinned per option so a refusal cannot decay into a bare "invalid
 * argument" while still passing the no-echo half.
 */
const VALIDATED_OPTION: Record<string, string> = {
	"--ttl": "That is not a lifetime.",
	"--limit": "--limit needs a positive whole number.",
	"--scope": "--scope must be profile, project or global.",
};

/**
 * The options that take any word at all, so there is no unreadable value for them to echo.
 *
 * `--from-env` takes a variable name and `--name` takes a secret name; every non-empty word is a
 * valid one, and both are echoed downstream on purpose. Listed rather than skipped so that a new
 * option cannot land in neither group unnoticed.
 */
const FREE_FORM_OPTIONS = ["--from-env", "--name"];

function wordsFor(verb: SecretSubcommand): string[] {
	const declared = SECRET_SUBCOMMAND_SHAPES[verb].words;
	const count = Number.isFinite(declared) ? declared : 1;
	const words: string[] = Array.from({ length: count }, (_, index) => (index === 0 ? "FIRST_TOKEN" : "SECOND_TOKEN"));
	if (verb === "scope") words[1] = "global";
	return words;
}

function wellFormedLine(verb: SecretSubcommand, extra: readonly string[] = []): string {
	const required = verb === "discard" && !extra.includes("--scope") ? ["--scope", "project"] : [];
	return [verb, ...wordsFor(verb), ...required, ...extra].join(" ");
}

/** `add` on a terminal is the value grammar: the sentinel there is stored, which is the point of it. */
function appliesTo(verb: SecretSubcommand, surface: SecretCommandSurface): boolean {
	return !(verb === "add" && surface === "tui");
}

/** Refuse, and prove the refusal is a refusal rather than a silent parse. */
function refusal(args: string, surface: SecretCommandSurface): string {
	try {
		parseSecretCommand(args, surface);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`parseSecretCommand("${args}", "${surface}") was accepted, so nothing was refused.`);
}

describe("the classification covers every option", () => {
	/** Fail by default: a new option belongs to one of the two groups, and somebody has to say which. */
	it("classifies every option as validated or free-form", () => {
		const unclassified = EVERY_OPTION.filter(
			option => VALIDATED_OPTION[option] === undefined && !FREE_FORM_OPTIONS.includes(option),
		);

		expect(unclassified).toEqual([]);
	});
});

describe("an extra bare word is refused without being repeated", () => {
	for (const verb of VERBS) {
		if (!Number.isFinite(SECRET_SUBCOMMAND_SHAPES[verb].words)) continue;
		for (const surface of SURFACES) {
			if (!appliesTo(verb, surface)) continue;

			it(`keeps a credential out of the ${verb} refusal, on the ${surface} surface`, () => {
				const message = refusal(wellFormedLine(verb, [SENTINEL]), surface);

				expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
				// A refusal that says nothing else is a wall, so it still has to name the command it is
				// talking about. Without this half, emptying the message would pass the leak assertion.
				expect(message).toContain(`/secret ${verb} takes`);
			});
		}
	}
});

describe("an option value that cannot be read is refused without being repeated", () => {
	for (const verb of VERBS) {
		for (const option of SECRET_SUBCOMMAND_SHAPES[verb].options) {
			const expected = VALIDATED_OPTION[option];
			if (expected === undefined) continue;
			for (const surface of SURFACES) {
				if (!appliesTo(verb, surface)) continue;

				it(`keeps a credential out of the ${verb} ${option} refusal, on the ${surface} surface`, () => {
					const message = refusal(wellFormedLine(verb, [option, SENTINEL]), surface);

					expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
					expect(message).toContain(expected);
				});
			}
		}
	}
});

describe("a first word that is not a verb is refused without being repeated", () => {
	/**
	 * The case that matters most, and the one that was briefly regressed.
	 *
	 * On a surface with no masked field, a client or a `-p` invocation typing `/secret <credential>`
	 * lands here. There is no terminal row for this: a terminal stores that line, which is the whole
	 * design of the value-first grammar.
	 */
	it("says the subcommand is unknown without saying what it was", () => {
		const message = refusal(SENTINEL, "noninteractive");

		expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
		expect(message).toContain("Unknown /secret subcommand.");
		// The usage is the actionable half, so the refusal has to carry it rather than only refusing.
		expect(message).toContain("/secret list");
	});

	/** A scope move's destination is a closed set of three, so a wrong one is never a name worth echoing. */
	it("asks which vault without repeating what was written", () => {
		const message = refusal(`scope FIRST_TOKEN ${SENTINEL}`, "noninteractive");

		expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
		expect(message).toContain("/secret scope <name> profile|project|global");
	});
});
