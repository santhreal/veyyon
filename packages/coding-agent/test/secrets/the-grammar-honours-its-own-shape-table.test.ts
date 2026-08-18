/**
 * Every `/secret` command reads exactly the slots its shape table declares, and nothing else, on
 * both surfaces.
 *
 * WHY THIS SUITE EXISTS. The contract used to be pinned by hand, command by command, in a file
 * written when there were five commands. There are thirteen now, and the ones that arrived last
 * reached the parser with nothing asserting their shape at all: a hand-written list of cases cannot
 * cover a member that did not exist when it was written, and a list that goes stale is
 * indistinguishable from no test. That file went away with the options it was written about, and this
 * one replaces it by deriving every case instead of listing it.
 *
 * SO THIS ONE IS DERIVED. Every case below comes out of `SECRET_SUBCOMMAND_SHAPES` at run time, so
 * adding a command adds its rows, and moving a slot from required to trailing moves that command
 * between the loops without anybody editing this file. A new slot with no sample fails the guard at
 * the top rather than being skipped by every loop in silence.
 *
 * WHAT IT CLOSES. The class is "a command accepts an argument it then ignores", which is the worst
 * outcome available because the operator is told the command ran. Every argument is a plain word now,
 * so the class has three spellings and all three are swept: a word past the last slot, a required
 * word that never arrived, and a trailing word written in an unexpected order. It also pins the two
 * safety properties of the refusals -- they never repeat the word, because on a `/secret` line the
 * misplaced word is very often the credential, and they never advertise a flag, because there are
 * none and offering one sends the operator to a line that would be refused.
 *
 * WHAT IT DOES NOT CATCH. It proves the parser honours the table; it cannot prove the table is the
 * right shape for a command. A vault being optional on `rm` and required on `clear` is a judgement,
 * and the suites that own those commands are where it is asserted. It also says nothing about what
 * the runner does with a parsed request.
 */
import { describe, expect, it } from "bun:test";
import {
	parseSecretCommand,
	SECRET_SUBCOMMAND_SHAPES,
	type SecretCommandRequest,
	type SecretCommandSurface,
	type SecretSlot,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";

const COMMANDS = Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[];

/** Every slot any command reads, derived so a new one cannot be added without reaching these loops. */
const EVERY_SLOT = [
	...new Set(
		COMMANDS.flatMap(command => [
			...SECRET_SUBCOMMAND_SHAPES[command].slots,
			...SECRET_SUBCOMMAND_SHAPES[command].trailing,
		]),
	),
].sort();

/**
 * A word each slot accepts, and the request field it must land in.
 *
 * Keyed by slot rather than derived, because only the parser knows what a lifetime looks like. The
 * guard below is what keeps it honest: a new slot with no entry here fails immediately with a message
 * naming it, rather than being skipped by every loop in silence.
 *
 * `variable` is the one slot spelled as two words when it trails, so its sample carries the keyword.
 * A name sample must be a legal secret name, since the required-slot rule hands whatever arrives
 * straight to the vault.
 */
const SLOT_SAMPLE: Record<SecretSlot, { words: readonly string[]; field: keyof SecretCommandRequest }> = {
	name: { words: ["FIRST_TOKEN"], field: "name" },
	newName: { words: ["SECOND_TOKEN"], field: "newName" },
	variable: { words: ["from-env", "SOME_VARIABLE"], field: "fromEnv" },
	scope: { words: ["project"], field: "scope" },
	ttl: { words: ["7d"], field: "ttl" },
	limit: { words: ["5"], field: "limit" },
};

const SURFACES: readonly SecretCommandSurface[] = ["tui", "noninteractive"];

/**
 * How many of a command's slots that surface insists on.
 *
 * ONE slot's necessity is per-surface: a terminal asks for the name of a `from-env` in a field
 * afterwards, so it may be left off the line there, and a client has no field and must write it. The
 * table cannot say that, because it describes the grammar and this is a fact about the surface -- so
 * it is stated here once and every loop below reads it, rather than each loop carrying an exception.
 */
function requiredOn(command: SecretSubcommand, surface: SecretCommandSurface): number {
	if (command === "from-env" && surface === "tui") return 1;
	return SECRET_SUBCOMMAND_SHAPES[command].required;
}

/** A required slot takes whatever arrives, so its sample is written without the trailing keyword. */
function requiredWords(command: SecretSubcommand, surface: SecretCommandSurface): string[] {
	const shape = SECRET_SUBCOMMAND_SHAPES[command];
	return shape.slots.slice(0, requiredOn(command, surface)).flatMap(slot => SLOT_SAMPLE[slot].words.at(-1) ?? "");
}

/** The shortest line the command accepts: its required words and nothing after them. */
function wellFormedLine(command: SecretSubcommand, surface: SecretCommandSurface): string {
	return [command, ...requiredWords(command, surface)].join(" ");
}

/**
 * The longest line the command accepts: every DECLARED slot, then every trailing slot filled once.
 *
 * Declared rather than required, so the terminal's optional `from-env` name is on the line here: a
 * saturated line is the one with nothing left to add, which is what makes the next word after it a
 * word too many.
 */
function saturatedLine(command: SecretSubcommand): string {
	const shape = SECRET_SUBCOMMAND_SHAPES[command];
	const positional = shape.slots.flatMap(slot => SLOT_SAMPLE[slot].words.at(-1) ?? "");
	const trailing = shape.trailing.flatMap(slot => [...SLOT_SAMPLE[slot].words]);
	return [command, ...positional, ...trailing].join(" ");
}

/**
 * The one command a terminal parses as a value grammar rather than through the table.
 *
 * `/secret add <value>` is where a terminal reads a credential, so everything after `add` is the value
 * and no slot is consulted. It is asserted where it belongs, in
 * `the-masked-prompt-cannot-be-read-as-a-name-prompt.test.ts`, and named here so it is a decision
 * rather than a gap. `from-env` used to be exempt too and no longer is: it reads the same slots on
 * both surfaces, and only the NECESSITY of its name differs, which `requiredOn` states.
 */
function appliesTo(command: SecretSubcommand, surface: SecretCommandSurface): boolean {
	return !(surface === "tui" && command === "add");
}

function refusal(args: string, surface: SecretCommandSurface): string {
	try {
		parseSecretCommand(args, surface);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`parseSecretCommand("${args}", "${surface}") was accepted, and should have been refused.`);
}

describe("the slot sample covers the grammar", () => {
	/** The guard that keeps every loop below from silently skipping a newly added slot. */
	it("names words and a field for every slot any command reads", () => {
		const missing = EVERY_SLOT.filter(slot => SLOT_SAMPLE[slot] === undefined);

		expect(missing).toEqual([]);
	});

	/** A shape table with no commands would make every loop below vacuous and every one of them pass. */
	it("derives at least the thirteen commands the grammar ships", () => {
		expect(COMMANDS.length).toBeGreaterThanOrEqual(13);
		expect(EVERY_SLOT.length).toBeGreaterThanOrEqual(6);
	});

	/** The table is the grammar, and a flag in it would be a flag in the grammar. */
	it("declares no slot whose spelling is an option", () => {
		expect(EVERY_SLOT.filter(slot => slot.startsWith("-"))).toEqual([]);
		expect(COMMANDS.filter(command => command.startsWith("-"))).toEqual([]);
	});
});

describe("a command accepts the words its table declares", () => {
	for (const command of COMMANDS) {
		for (const surface of SURFACES) {
			if (!appliesTo(command, surface)) continue;

			it(`accepts ${command} with its required words, on the ${surface} surface`, () => {
				expect(parseSecretCommand(wellFormedLine(command, surface), surface).subcommand).toBe(command);
			});

			it(`reads every trailing word ${command} declares, on the ${surface} surface`, () => {
				const request = parseSecretCommand(saturatedLine(command), surface);

				expect(request.subcommand).toBe(command);
				// Accepting a word and dropping it is the defect this whole suite is about, so each field
				// has to arrive, not merely fail to throw.
				for (const slot of SECRET_SUBCOMMAND_SHAPES[command].trailing) {
					expect(request[SLOT_SAMPLE[slot].field]).toBeDefined();
				}
			});
		}
	}
});

describe("trailing words are read in any order", () => {
	for (const command of COMMANDS) {
		const trailing = SECRET_SUBCOMMAND_SHAPES[command].trailing;
		if (trailing.length < 2) continue;
		for (const surface of SURFACES) {
			if (!appliesTo(command, surface)) continue;

			it(`reads ${command}'s trailing words reversed, on the ${surface} surface`, () => {
				const reversed = [...trailing].reverse().flatMap(slot => [...SLOT_SAMPLE[slot].words]);
				const request = parseSecretCommand(
					[command, ...requiredWords(command, surface), ...reversed].join(" "),
					surface,
				);

				// Order-free is the whole point of recognising a trailing word by its shape: an operator
				// who writes the vault before the lifetime has not made a mistake.
				for (const slot of trailing) expect(request[SLOT_SAMPLE[slot].field]).toBeDefined();
			});
		}
	}
});

describe("a required word that never arrived is refused", () => {
	for (const command of COMMANDS) {
		for (const surface of SURFACES) {
			if (!appliesTo(command, surface)) continue;
			if (requiredOn(command, surface) === 0) continue;

			it(`refuses ${command} one required word short, on the ${surface} surface`, () => {
				const short = requiredWords(command, surface).slice(0, -1);
				const message = refusal([command, ...short].join(" "), surface);
				const shape = SECRET_SUBCOMMAND_SHAPES[command];
				// A MISSING VAULT KEEPS ITS OWN SENTENCE, and which commands those are is derived from the
				// same table rather than listed: `clear`, `discard` and `scope` act on something that
				// already exists, so their refusals say WHY there is no default instead of only what is
				// missing. Every other command gets the generic one.
				const missingVault = shape.needsScope && shape.slots.slice(short.length).includes("scope");

				expect(message).toContain(missingVault ? "There is no default" : `/secret ${command} still needs`);
				expect(message).toContain(`/secret ${command}`);
				// The words that DID arrive are not repeated: one of them may be the credential, put on
				// the line by muscle memory for `add`.
				for (const word of short) expect(message).not.toContain(word);
			});
		}
	}
});

describe("a word past the last slot is refused", () => {
	for (const command of COMMANDS) {
		for (const surface of SURFACES) {
			if (!appliesTo(command, surface)) continue;

			it(`refuses one word more than ${command} reads, on the ${surface} surface`, () => {
				const message = refusal(`${saturatedLine(command)} EXTRA_WORD`, surface);

				// WHICH refusal is derived, not chosen. There are three, and pinning the wrong one per
				// command is how this row would pass while saying nothing:
				//
				//  - a command whose trailing slots include a name has no unreadable shape left, since a
				//    name is the catch-all, so one word too many is a SECOND name and is refused as a
				//    repeat;
				//  - `add` on a client reads no words at all, and whatever arrived may be the credential,
				//    so it is refused as an inline credential in a request log;
				//  - everything else has no slot for the word.
				//
				// All three are the same contract: the word is not silently ignored.
				const expected =
					command === "add"
						? "refuses an inline credential"
						: SECRET_SUBCOMMAND_SHAPES[command].trailing.includes("name")
							? `/secret ${command} reads a secret name once`
							: `/secret ${command} cannot read`;
				expect(message).toContain(expected);
				expect(message).not.toContain("EXTRA_WORD");
				// A terminal line one word too long has a second reading: a credential beginning with a
				// command word. The value form is the only spelling for it, and it is wrong to offer on a
				// surface with no bare-value form to reach for. Asserted for every refusal above, not just
				// the extra-word one, because the operator's mistake is identical in all of them.
				if (surface === "tui") expect(message).toContain("store it with /secret add <value>.");
				else expect(message).not.toContain("store it with /secret add <value>.");
			});
		}
	}
});

describe("no refusal sends the operator to a flag", () => {
	for (const command of COMMANDS) {
		for (const surface of SURFACES) {
			if (!appliesTo(command, surface)) continue;

			it(`names no option when it refuses ${command}, on the ${surface} surface`, () => {
				const message = refusal(`${saturatedLine(command)} EXTRA_WORD`, surface);

				// Nothing in this grammar is spelled with a dash, so a refusal that advertises one hands
				// the operator a line the parser would refuse in turn -- which reads as a bug in the tool
				// rather than as a rule about the tool.
				expect(message).not.toMatch(/(^|\s)--?[a-z]/);
			});
		}
	}
});

/** The value grammar is unbounded on purpose: its tail is a credential, not a word list. */
it("keeps every word of an inline credential on add", () => {
	const request = parseSecretCommand("add one two three four", "tui");

	expect(request.value).toBe("one two three four");
});
