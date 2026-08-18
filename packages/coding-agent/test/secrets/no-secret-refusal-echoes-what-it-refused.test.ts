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
 * It has already regressed twice in opposite directions. The limit refusal quoted the word it could
 * not read for every command but `add`, and an unknown-command refusal was briefly made to name the
 * word it did not recognise, which on a noninteractive surface is most often the credential itself.
 *
 * SO THE CASES ARE DERIVED. Every case below is generated from `SECRET_SUBCOMMAND_SHAPES`: a word past
 * the last slot of each command, and a word that cannot be read in each validated slot each command
 * declares. A new command is covered the moment it is declared, and a new slot turns this suite red
 * until it is classified as validated or free-form.
 *
 * WHAT IT DOES NOT CATCH. One echo is deliberate and is excluded by name rather than removed: a
 * stored NAME is repeated by the runner, because a name is not a secret and the operator needs to know
 * which one was not found. This suite covers the parser, which is where a line's bytes are still
 * arbitrary; the runner only ever sees a name it has already normalised. It also cannot prove a
 * refusal is comprehensible -- only that it neither leaks nor goes silent.
 */
import { describe, expect, it } from "bun:test";
import {
	parseSecretCommand,
	SECRET_SUBCOMMAND_SHAPES,
	type SecretCommandSurface,
	type SecretSlot,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";

/**
 * A credential shaped like the ones people actually paste, and long enough to be worth protecting.
 *
 * Mixed case on purpose: a refusal that lowercases or uppercases what it echoes is still an echo,
 * so every assertion compares case-insensitively and a normalised leak is caught too.
 */
const SENTINEL = "ghp_LiveSentinelBytes0123456789";

const COMMANDS = Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[];
const SURFACES: readonly SecretCommandSurface[] = ["tui", "noninteractive"];
const EVERY_SLOT = [
	...new Set(
		COMMANDS.flatMap(command => [
			...SECRET_SUBCOMMAND_SHAPES[command].slots,
			...SECRET_SUBCOMMAND_SHAPES[command].trailing,
		]),
	),
].sort();

/**
 * The slots whose word belongs to a validated domain: a word that cannot be read, and the sentence
 * the refusal must carry.
 *
 * The lifetime sentence names the shape it wanted rather than the slot, because the operator's
 * mistake is the lifetime itself. Pinned per slot so a refusal cannot decay into a bare "invalid
 * argument" while still passing the no-echo half.
 *
 * The limit's bad word is digits that overflow a safe integer, because the parser only reaches the
 * limit slot for a word made of digits -- anything else is either another slot or an extra word.
 */
const VALIDATED_SLOT: Record<string, { bad: string; sentence: string }> = {
	ttl: { bad: SENTINEL, sentence: "That is not a lifetime." },
	scope: { bad: SENTINEL, sentence: "Which vault? Write profile, project or global." },
	limit: { bad: "999999999999999999999", sentence: "How many records? Write a positive whole number" },
};

/**
 * The slots that take any word at all, so there is no unreadable word for them to echo.
 *
 * A variable slot takes an environment variable name and the name slots take a secret name; every
 * non-empty word is a valid one there, and all three are echoed downstream on purpose. Listed rather
 * than skipped so that a new slot cannot land in neither group unnoticed.
 */
const FREE_FORM_SLOTS: readonly SecretSlot[] = ["name", "newName", "variable"];

/** A word for each slot that the parser reads without complaint, used to build a line that parses. */
const GOOD_WORD: Record<SecretSlot, string> = {
	name: "FIRST_TOKEN",
	newName: "SECOND_TOKEN",
	variable: "SOME_VARIABLE",
	scope: "project",
	ttl: "7d",
	limit: "5",
};

/**
 * The positional words of a command, with one slot's word swapped for something unreadable.
 *
 * EVERY declared slot, so a slot that is optional on one surface is still filled here: the swapped
 * word has to be ON the line for the refusal it provokes to exist at all.
 */
function lineWithBadWord(command: SecretSubcommand, target: SecretSlot, bad: string): string {
	const shape = SECRET_SUBCOMMAND_SHAPES[command];
	const words = shape.slots.map(slot => (slot === target ? bad : GOOD_WORD[slot]));
	return [command, ...words].join(" ");
}

/**
 * The longest line a command accepts, so an appended word has no slot left to fall into.
 *
 * EVERY DECLARED SLOT, not merely the required ones: the terminal's `from-env` name is optional and
 * still a slot, so a line without it has somewhere for the next word to go and would not be saturated.
 */
function saturatedLine(command: SecretSubcommand): string {
	const shape = SECRET_SUBCOMMAND_SHAPES[command];
	const positional = shape.slots.map(slot => GOOD_WORD[slot]);
	const trailing = shape.trailing.flatMap(slot =>
		slot === "variable" ? ["from-env", GOOD_WORD[slot]] : [GOOD_WORD[slot]],
	);
	return [command, ...positional, ...trailing].join(" ");
}

/**
 * The one command a terminal parses as a value grammar: the sentinel there is stored, which is the
 * point of it. `from-env` reads slots on both surfaces, so it is swept on both.
 */
function appliesTo(command: SecretSubcommand, surface: SecretCommandSurface): boolean {
	return !(surface === "tui" && command === "add");
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

describe("the classification covers every slot", () => {
	/** Fail by default: a new slot belongs to one of the two groups, and somebody has to say which. */
	it("classifies every slot as validated or free-form", () => {
		const unclassified = EVERY_SLOT.filter(
			slot => VALIDATED_SLOT[slot] === undefined && !FREE_FORM_SLOTS.includes(slot),
		);

		expect(unclassified).toEqual([]);
	});
});

describe("a word past the last slot is refused without being repeated", () => {
	for (const command of COMMANDS) {
		for (const surface of SURFACES) {
			if (!appliesTo(command, surface)) continue;

			it(`keeps a credential out of the ${command} refusal, on the ${surface} surface`, () => {
				const message = refusal(`${saturatedLine(command)} ${SENTINEL}`, surface);

				expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
				// A refusal that says nothing else is a wall, so it still has to name the command it is
				// talking about. Without this half, emptying the message would pass the leak assertion.
				// Which sentence is DERIVED rather than chosen, so the row cannot pin the wrong one and pass
				// on a message about something else: a command with a trailing NAME slot has no unreadable
				// shape left, so a word too many is a second name and is refused as a repeat, and `add` on a
				// client reads no words at all, so whatever arrived is treated as the credential it may be.
				expect(message).toContain(
					command === "add"
						? "refuses an inline credential"
						: SECRET_SUBCOMMAND_SHAPES[command].trailing.includes("name")
							? `/secret ${command} reads a secret name once`
							: `/secret ${command} cannot read`,
				);
			});
		}
	}
});

describe("a validated word that cannot be read is refused without being repeated", () => {
	for (const command of COMMANDS) {
		const shape = SECRET_SUBCOMMAND_SHAPES[command];
		for (const slot of shape.slots) {
			const validated = VALIDATED_SLOT[slot];
			if (validated === undefined) continue;
			for (const surface of SURFACES) {
				if (!appliesTo(command, surface)) continue;

				it(`keeps a credential out of the ${command} ${slot} refusal, on the ${surface} surface`, () => {
					const message = refusal(lineWithBadWord(command, slot, validated.bad), surface);

					expect(message.toLowerCase()).not.toContain(validated.bad.toLowerCase());
					expect(message).toContain(validated.sentence);
				});
			}
		}
	}

	/**
	 * The limit is reachable only as a trailing word, and only for digits, so it gets its own row.
	 *
	 * Not a leak risk in the same way -- a credential that is nothing but digits is unusual -- but the
	 * refusal is still pinned, because a limit that overflows silently would show the default twenty
	 * records and say nothing, which is the defect the whole trailing-word design exists to prevent.
	 */
	it("refuses a limit it cannot represent, on both surfaces", () => {
		const validated = VALIDATED_SLOT.limit;
		for (const surface of SURFACES) {
			const message = refusal(`log ${validated.bad}`, surface);

			expect(message).toContain(validated.sentence);
		}
	});
});

describe("a first word that is not a command is refused without being repeated", () => {
	/**
	 * The case that matters most, and the one that was briefly regressed.
	 *
	 * Both surfaces refuse it now. A terminal used to store the line, which is what made a pasted
	 * credential with no command word a stored secret with a generated name.
	 */
	it("says the command is unknown without saying what it was", () => {
		for (const surface of SURFACES) {
			const message = refusal(SENTINEL, surface);

			expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
			expect(message).toContain("Unknown /secret command.");
			// The usage is the actionable half, so the refusal has to carry it rather than only refusing.
			expect(message).toContain("/secret list");
		}
	});

	/** A vault is a closed set of three words, so a wrong one is never a name worth echoing. */
	it("asks which vault without repeating what was written", () => {
		const message = refusal(`scope FIRST_TOKEN ${SENTINEL}`, "noninteractive");

		expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
		expect(message).toContain("Which vault? Write profile, project or global.");
	});
});
