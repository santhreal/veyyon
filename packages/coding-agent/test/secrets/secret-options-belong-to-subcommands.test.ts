/**
 * An option given to a `/secret` subcommand that does not read it is refused.
 *
 * WHY THIS SUITE EXISTS. The parser accepted every option for every verb, and each subcommand then
 * read only the fields it cared about. Nothing failed. `/secret extend NAME --scope global`
 * reported a fresh lifetime and did nothing at all about the scope, and `/secret rm NAME --scope
 * project` printed a removal that had actually taken whichever copy was in effect, leaving the
 * project copy the operator was aiming at still in place.
 *
 * That is a silent no-op, and it is on the command whose entire job is moving credentials around,
 * where "I thought I had removed that" is the sentence you least want an operator to say. Accepting
 * an argument and ignoring it is worse than rejecting it, because rejection is information.
 *
 * The other half of what these tests pin is that the refusal is USEFUL: it names the subcommand
 * that does take the option, so the operator learns the right command instead of only learning
 * that they typed the wrong one. And the options that ARE valid keep working, so the guard has not
 * been bought by refusing things that used to work.
 */
import { describe, expect, it } from "bun:test";
import { parseSecretCommand } from "@veyyon/coding-agent/secrets/secret-command";

/** Parse, returning the thrown message. */
function refusal(args: string): string {
	try {
		parseSecretCommand(args);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`parseSecretCommand("${args}") was accepted, and should have been refused.`);
}

describe("--scope on a subcommand that ignores it", () => {
	/**
	 * THE WORST CASE, and the reason this guard exists at all.
	 *
	 * `rm` walks scopes narrowest-first and removes the entry in effect. An accepted-and-ignored
	 * `--scope project` therefore prints "Removed X from the profile vault" for a command that said
	 * `project`, and an operator scanning output sees a removal and moves on.
	 */
	it("refuses --scope on rm, naming add", () => {
		const message = refusal("rm github-token --scope project");

		expect(message).toContain("/secret rm does not take --scope");
		expect(message).toContain("would look like it had been applied");
		expect(message).toContain("/secret add takes it");
	});

	/**
	 * `extend` has the same shape: it re-dates the entry in effect and cannot move one.
	 */
	it("refuses --scope on extend", () => {
		expect(refusal("extend github-token --ttl 7d --scope global")).toContain("/secret extend does not take --scope");
	});

	/** `list` shows every scope already, so a scope filter it does not implement is refused. */
	it("refuses --scope on list", () => {
		expect(refusal("list --scope project")).toContain("/secret list does not take --scope");
	});

	/** And on log, where it never meant anything. */
	it("refuses --scope on log", () => {
		expect(refusal("log --scope profile")).toContain("/secret log does not take --scope");
	});
});

describe("--ttl on a subcommand that ignores it", () => {
	/** `rm` deletes the entry, so a lifetime for it is meaningless. */
	it("refuses --ttl on rm, naming both verbs that take it", () => {
		const message = refusal("rm github-token --ttl 7d");

		expect(message).toContain("/secret rm does not take --ttl");
		expect(message).toContain("/secret add");
		expect(message).toContain("/secret extend");
	});

	/** `list` reports lifetimes rather than setting them. */
	it("refuses --ttl on list", () => {
		expect(refusal("list --ttl 7d")).toContain("/secret list does not take --ttl");
	});
});

describe("--limit outside the log", () => {
	/**
	 * Refused on `add`, where a limit that silently vanished used to be accepted.
	 *
	 * This one is not dangerous, and it is refused anyway: the rule is "an ignored option is a
	 * refusal", and a rule with per-option exceptions is one nobody can predict.
	 */
	it("refuses --limit on add, naming log", () => {
		const message = refusal("add github-token --from-env TOK --limit 5");

		expect(message).toContain("/secret add does not take --limit");
		expect(message).toContain("/secret log takes it");
	});

	/** And on list, which shows everything by design and has no paging. */
	it("refuses --limit on list", () => {
		expect(refusal("list --limit 5")).toContain("/secret list does not take --limit");
	});
});

describe("--from-env outside add", () => {
	/** Only `add` reads a value from the environment; nothing else has a value to read. */
	it("refuses --from-env on extend", () => {
		expect(refusal("extend github-token --from-env TOK")).toContain("/secret extend does not take --from-env");
	});

	/** Including on rm, where it would read as "remove the one from this variable". */
	it("refuses --from-env on rm", () => {
		expect(refusal("rm github-token --from-env TOK")).toContain("/secret rm does not take --from-env");
	});
});

describe("the refusal's shape", () => {
	/** The usage text is attached, so the operator sees the whole command surface at once. */
	it("shows the usage", () => {
		const message = refusal("rm github-token --scope project");

		expect(message).toContain("/secret list");
		expect(message).toContain("/secret log");
	});

	/**
	 * Singular and plural agree with how many verbs take the option.
	 *
	 * "/secret add and /secret extend take it" against "/secret add takes it". A message that reads
	 * as broken English undermines the advice it is giving.
	 */
	it("agrees in number with the verbs it names", () => {
		expect(refusal("list --scope project")).toContain("/secret add takes it");
		expect(refusal("list --ttl 7d")).toContain("/secret add and /secret extend take it");
	});
});

describe("options where they belong", () => {
	/** `add` takes all three of its options together, and each lands on the request. */
	it("accepts --from-env, --ttl and --scope on add", () => {
		const request = parseSecretCommand("add github-token --from-env GH_PAT --ttl 30m --scope project");

		expect(request.subcommand).toBe("add");
		expect(request.name).toBe("github-token");
		expect(request.fromEnv).toBe("GH_PAT");
		expect(request.ttl).toBe(30 * 60 * 1000);
		expect(request.scope).toBe("project");
	});

	/** `extend` takes a lifetime, including `never`, which parses to null rather than to a number. */
	it("accepts --ttl on extend", () => {
		expect(parseSecretCommand("extend github-token --ttl 7d").ttl).toBe(7 * 24 * 60 * 60 * 1000);
		expect(parseSecretCommand("extend github-token --ttl never").ttl).toBeNull();
	});

	/** `log` takes a limit, under both its name and its alias. */
	it("accepts --limit on log and on audit", () => {
		expect(parseSecretCommand("log --limit 50").limit).toBe(50);
		expect(parseSecretCommand("audit --limit 50")).toMatchObject({ subcommand: "log", limit: 50 });
	});

	/** No options at all is the common case and stays untouched. */
	it("accepts every subcommand with no options", () => {
		for (const verb of ["list", "log", "help"]) {
			expect(() => parseSecretCommand(verb)).not.toThrow();
		}
		expect(() => parseSecretCommand("rm github-token")).not.toThrow();
		expect(() => parseSecretCommand("add github-token")).not.toThrow();
	});

	/**
	 * An unknown option is still refused by the earlier branch, not swallowed by this one.
	 *
	 * Two different mistakes with two different messages: a misspelled option and an option in the
	 * wrong place need different advice.
	 */
	it("still refuses an option that does not exist at all", () => {
		expect(refusal("add --scoped project github-token")).toContain('Unknown option "--scoped"');
	});
});

describe("a bare word the subcommand does not read", () => {
	/**
	 * THE SAME BUG IN THE SHAPE PEOPLE TYPE IT.
	 *
	 * `/secret log 50` is the natural way to ask for fifty records. It used to parse the `50` into
	 * `request.name`, which `showLog` never reads, so the command printed the default twenty and said
	 * nothing about the number that had been asked for. The operator concludes twenty is all there is.
	 *
	 * The message has to teach `--limit`, because "too many arguments" does not tell somebody who
	 * typed `/secret log 50` what to type instead, and it echoes the number they gave.
	 */
	it("refuses a count after log and names --limit with that number", () => {
		const message = refusal("log 50");

		expect(message).toContain("/secret log takes no arguments");
		expect(message).toContain('"50" would be ignored');
		expect(message).toContain("/secret log --limit 50");
	});

	/** A non-numeric word gets the same advice with a plausible number rather than an echo. */
	it("suggests --limit with an example when the word is not a number", () => {
		expect(refusal("log recent")).toContain("/secret log --limit 50");
	});

	/** `list` shows everything and reads no word at all. */
	it("refuses a word after list", () => {
		expect(refusal("list github-token")).toContain("/secret list takes no arguments");
	});

	/**
	 * A second word after `rm` is refused rather than silently kept as a value.
	 *
	 * `rm` reads one name. The parser assigned everything after it to `request.value`, which
	 * `removeSecret` does not read, so `/secret rm NAME oops` removed `NAME` and discarded `oops`
	 * without comment.
	 */
	it("refuses a second word after rm", () => {
		const message = refusal("rm github-token extra");

		expect(message).toContain("/secret rm takes 1 argument(s)");
		expect(message).toContain('"extra" would be ignored');
	});

	/** And after extend, where the lifetime belongs to `--ttl` and not to a bare word. */
	it("refuses a second word after extend", () => {
		expect(refusal("extend github-token 7d")).toContain("/secret extend takes 1 argument(s)");
	});
});

describe("bare words where they belong", () => {
	/**
	 * `add` is unbounded, and the value keeps its spaces.
	 *
	 * The word count cannot apply to `add`: everything after the name is rejoined into the credential,
	 * and a passphrase contains spaces. A guard that counted words here would refuse a real
	 * passphrase as "too many arguments", which is the guard doing more harm than the bug it closes.
	 * That is what an earlier version of this check did, and this test is why it does not now.
	 */
	it("accepts a name and a multi-word value on add", () => {
		const request = parseSecretCommand("add github-token my secret pass phrase");

		expect(request.name).toBe("github-token");
		expect(request.value).toBe("my secret pass phrase");
	});

	/** A name alone on add is the masked-prompt case and takes no second word. */
	it("accepts a name alone on add", () => {
		expect(parseSecretCommand("add github-token").value).toBeUndefined();
	});

	/** One name is what rm and extend read. */
	it("accepts one name on rm and extend", () => {
		expect(parseSecretCommand("rm github-token").name).toBe("github-token");
		expect(parseSecretCommand("extend github-token --ttl 7d").name).toBe("github-token");
	});

	/** No words at all is valid everywhere that takes none. */
	it("accepts list and log with no words", () => {
		expect(parseSecretCommand("list").subcommand).toBe("list");
		expect(parseSecretCommand("log").subcommand).toBe("log");
	});
});
