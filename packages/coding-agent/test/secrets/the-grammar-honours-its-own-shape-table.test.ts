/**
 * Every `/secret` verb reads exactly the options and the word count its shape table declares, on
 * both surfaces.
 *
 * WHY THIS SUITE EXISTS. `secret-options-belong-to-subcommands.test.ts` pins the same contract by
 * hand, verb by verb and option by option, and it was written when there were five verbs. There are
 * eleven now, and the four that arrived last (`rename`, `value`, `scope`, `copy`) reached the parser
 * with nothing asserting their shape at all: a hand-written list of cases cannot cover a member that
 * did not exist when it was written, and a list that goes stale is indistinguishable from no test.
 *
 * SO THIS ONE IS DERIVED. Every case below comes out of `SECRET_SUBCOMMAND_SHAPES` at run time, so
 * adding a verb adds its rows, and adding an option to a verb moves that pair from the refusal loop
 * to the acceptance loop without anybody editing this file. A new verb whose positional words are a
 * closed set (the way `scope`'s destination is) fails here rather than passing, because the generic
 * name this suite feeds it is not a member of that set.
 *
 * WHAT IT CLOSES. The class is "a verb accepts an argument it then ignores", in both its spellings:
 * an option the verb does not read, and a bare word past the count it reads. Ignoring an argument is
 * the worst outcome available, because the operator is told the command ran. It also pins that the
 * refusal stays useful and stays safe: it names the verbs that DO take the option, it names the
 * position of the extra word without repeating the word, and it offers the `--` escape on the
 * terminal and not on a surface where `--` is not a value escape.
 *
 * WHAT IT DOES NOT CATCH. It proves the parser honours the table; it cannot prove the table is the
 * right shape for a verb. `rm --scope` being optional while `discard --scope` is required is a
 * judgement, and the suites that own those verbs are where it is asserted. It also says nothing
 * about what the runner does with a parsed request.
 */
import { describe, expect, it } from "bun:test";
import {
	parseSecretCommand,
	SECRET_SUBCOMMAND_SHAPES,
	type SecretCommandRequest,
	type SecretCommandSurface,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";

const VERBS = Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[];

/** Every option any verb reads, derived so a new one cannot be added without reaching these loops. */
const EVERY_OPTION = [...new Set(VERBS.flatMap(verb => SECRET_SUBCOMMAND_SHAPES[verb].options))].sort();

/**
 * A value each option accepts, and the request field it must land in.
 *
 * Keyed by option rather than derived, because only the parser knows what a lifetime looks like.
 * The guard below is what keeps it honest: a new option with no entry here fails immediately with a
 * message naming it, rather than being skipped by every loop in silence.
 */
const OPTION_SAMPLE: Record<string, { value: string; field: keyof SecretCommandRequest }> = {
	"--from-env": { value: "SOME_VARIABLE", field: "fromEnv" },
	"--ttl": { value: "7d", field: "ttl" },
	"--scope": { value: "project", field: "scope" },
	"--limit": { value: "5", field: "limit" },
	"--name": { value: "OTHER_TOKEN", field: "name" },
};

const SURFACES: readonly SecretCommandSurface[] = ["tui", "noninteractive"];

/**
 * The bare words a verb needs to be well formed, at exactly the count it declares.
 *
 * `add` is unbounded because its tail is a credential, so it is given a name and nothing else: an
 * option after an inline value is refused as ambiguous, which is a different contract with its own
 * suite. A destination that belongs to a closed set is spelled out, and any future verb with one
 * will fail the acceptance rows until it is spelled out here too.
 */
function wordsFor(verb: SecretSubcommand): string[] {
	const declared = SECRET_SUBCOMMAND_SHAPES[verb].words;
	const count = Number.isFinite(declared) ? declared : 1;
	const words: string[] = Array.from({ length: count }, (_, index) => (index === 0 ? "FIRST_TOKEN" : "SECOND_TOKEN"));
	if (verb === "scope") words[1] = "global";
	return words;
}

/**
 * A line that parses: the verb, its words, and every option it must be given to be complete.
 *
 * WHICH verbs must name a scope is read from the shape table's `needsScope`, not listed here. It was
 * listed here, as `verb === "discard"`, and a second verb with the same requirement then failed
 * these rows for a reason that had nothing to do with the contract they defend -- the line this
 * helper built was simply incomplete. A verb whose scope arrives as a positional (`scope`) already
 * has it from `wordsFor`, so only the `--scope` spelling is added here.
 *
 * Supplying an option twice is its own refusal, so the caller's `--scope` wins when that is the pair
 * under test.
 */
function wellFormedLine(verb: SecretSubcommand, extra: readonly string[] = []): string {
	const shape = SECRET_SUBCOMMAND_SHAPES[verb];
	const required =
		shape.needsScope && shape.options.includes("--scope") && !extra.includes("--scope") ? ["--scope", "project"] : [];
	return [verb, ...wordsFor(verb), ...required, ...extra].join(" ");
}

/**
 * `add` on a terminal is the value grammar, not the verb grammar.
 *
 * `/secret add <value>` is where a terminal reads a value, so everything after `add` is the
 * credential and the shape table does not apply. That is asserted where it belongs, in
 * `the-masked-prompt-cannot-be-read-as-a-name-prompt.test.ts`; here it is the one exemption, named
 * so that it is a decision rather than a gap.
 */
function appliesTo(verb: SecretSubcommand, surface: SecretCommandSurface): boolean {
	return !(verb === "add" && surface === "tui");
}

function refusal(args: string, surface: SecretCommandSurface): string {
	try {
		parseSecretCommand(args, surface);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`parseSecretCommand("${args}", "${surface}") was accepted, and should have been refused.`);
}

describe("the option sample covers the grammar", () => {
	/** The guard that keeps every loop below from silently skipping a newly added option. */
	it("names a value and a field for every option any verb reads", () => {
		const missing = EVERY_OPTION.filter(option => OPTION_SAMPLE[option] === undefined);

		expect(missing).toEqual([]);
	});

	/** A shape table with no verbs would make every loop below vacuous and every one of them pass. */
	it("derives at least the eleven verbs the command ships", () => {
		expect(VERBS.length).toBeGreaterThanOrEqual(11);
		expect(EVERY_OPTION.length).toBeGreaterThanOrEqual(5);
	});
});

describe("an option a verb does not read is refused", () => {
	for (const verb of VERBS) {
		const owned = SECRET_SUBCOMMAND_SHAPES[verb].options;
		const owners = (option: string) =>
			VERBS.filter(candidate => SECRET_SUBCOMMAND_SHAPES[candidate].options.includes(option));
		for (const option of EVERY_OPTION) {
			if (owned.includes(option)) continue;
			for (const surface of SURFACES) {
				if (!appliesTo(verb, surface)) continue;

				it(`refuses ${option} on ${verb}, on the ${surface} surface`, () => {
					const sample = OPTION_SAMPLE[option];
					const message = refusal(wellFormedLine(verb, [option, sample.value]), surface);

					expect(message).toContain(`/secret ${verb} does not take ${option}`);
					// The refusal is only useful if it points somewhere, and the owners it points at are
					// the table's own, so a verb that gains the option changes this expectation with it.
					for (const owner of owners(option)) expect(message).toContain(`/secret ${owner}`);
				});
			}
		}
	}
});

describe("an option a verb declares is read into the request", () => {
	for (const verb of VERBS) {
		for (const option of SECRET_SUBCOMMAND_SHAPES[verb].options) {
			for (const surface of SURFACES) {
				if (!appliesTo(verb, surface)) continue;

				it(`reads ${option} on ${verb}, on the ${surface} surface`, () => {
					const sample = OPTION_SAMPLE[option];
					const request = parseSecretCommand(wellFormedLine(verb, [option, sample.value]), surface);

					expect(request.subcommand).toBe(verb);
					// Accepting an option and dropping it is the defect this whole suite is about, so the
					// field has to arrive, not merely fail to throw.
					expect(request[sample.field]).toBeDefined();
				});
			}
		}
	}
});

describe("a bare word past the count is refused", () => {
	for (const verb of VERBS) {
		const declared = SECRET_SUBCOMMAND_SHAPES[verb].words;
		for (const surface of SURFACES) {
			if (!appliesTo(verb, surface)) continue;

			it(`accepts ${verb} at its declared word count, on the ${surface} surface`, () => {
				expect(parseSecretCommand(wellFormedLine(verb), surface).subcommand).toBe(verb);
			});

			if (!Number.isFinite(declared)) continue;

			it(`refuses one word more than ${verb} reads, on the ${surface} surface`, () => {
				const message = refusal(wellFormedLine(verb, ["EXTRA_WORD"]), surface);

				expect(message).toContain(`/secret ${verb} takes`);
				expect(message).not.toContain("EXTRA_WORD");
				// A terminal line one word too long has a second reading: a credential beginning with that
				// verb. The escape is the only spelling for it, and it is wrong to offer on a surface with
				// no bare-value form to escape into.
				if (surface === "tui") expect(message).toContain("store it with /secret add <value>.");
				else expect(message).not.toContain("store it with /secret add <value>.");
			});
		}
	}

	/** The unbounded verb is unbounded on purpose: its tail is a credential, not a word list. */
	it("keeps every word of an inline credential on add", () => {
		const request = parseSecretCommand("add DEPLOY_KEY one two three four", "noninteractive");

		expect(request.name).toBe("DEPLOY_KEY");
		expect(request.value).toBe("one two three four");
	});
});
