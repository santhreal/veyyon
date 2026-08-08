/**
 * The declaration table after `/providers` stopped being an alias of `/setup`.
 *
 * WHY THIS SUITE EXISTS. `/providers` used to resolve to the onboarding wizard, and the alias is
 * exactly the kind of thing that gets restored by accident: it is one word in a list, it makes a
 * test about setup pass, and nothing else in the tree notices. These assertions drive the REAL
 * declaration table and the real name lookup, so the door `/providers` opens cannot be moved back
 * without failing here.
 *
 * They also lock the absence of `/provider` (singular). A singular alias is the natural thing to
 * add "for convenience", and it would give the account manager two names, only one of which any
 * documentation, hint or welcome row mentions.
 */
import { describe, expect, it } from "bun:test";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";

const declarations: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

function declarationFor(name: string): BuiltinSlashCommandDeclaration {
	const found = declarations.find(command => command.name === name);
	if (!found) throw new Error(`no declaration named ${name}`);
	return found;
}

describe("/providers is its own command", () => {
	/**
	 * `/providers` is declared, not aliased. An alias would inherit `/setup`'s handler, which is the
	 * wizard — the precise defect this feature removes.
	 */
	it("is declared with its own description", () => {
		expect(declarationFor("providers").description).toBe("Manage accounts for every provider");
	});

	/**
	 * Nothing anywhere in the table claims `providers` as an ALIAS. Aliases are resolved by the same
	 * lookup as names, so an alias of that spelling on any command would shadow or race the real
	 * one depending on registry order.
	 */
	it("is claimed as an alias by no command", () => {
		const aliasOwners = declarations
			.filter(command => (command.aliases ?? []).includes("providers"))
			.map(command => command.name);

		expect(aliasOwners).toEqual([]);
	});

	/** The autocomplete/palette surface sees the command too, since it is built from the registry. */
	it("appears in the command definitions the palette reads", () => {
		const listed = BUILTIN_SLASH_COMMAND_DEFS.filter(command => command.name === "providers");

		expect(listed).toHaveLength(1);
		expect(listed[0]?.aliases ?? []).toEqual([]);
	});
});

describe("/provider (singular) does not exist", () => {
	/**
	 * The reserved-name set is every name the parser accepts, names and aliases together. Asserting
	 * against it is what catches the singular spelling however it was added.
	 */
	it("is neither a command name nor an alias", () => {
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("provider")).toBe(false);
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("providers")).toBe(true);
	});
});

describe("/account declares the verbs it answers to", () => {
	/**
	 * `/account` must be drivable from ACP and RPC, not only the TUI, because the inline block is
	 * the form of this feature a client without a terminal can use at all. `textMode` is what the
	 * ACP advertisement and the available-commands list read, and the registry's handler table makes
	 * a declared `textMode` without a `handle` a compile error.
	 */
	it("is a text-mode command with an ACP description and input hint", () => {
		const account = declarationFor("account");

		expect(account.textMode).toBe(true);
		expect(account.allowArgs).toBe(true);
		expect(account.acpDescription).toBe("Show the accounts this session is using");
		expect(account.acpInputHint).toBe("[status|manager|switch|use|name|refresh|usage|login|logout]");
	});

	/**
	 * Every verb the handler routes is advertised, in the order the help surfaces show them. The
	 * handler builds its own "unknown verb" diagnostic from this list, so a verb missing here is a
	 * verb the diagnostic will not offer even though typing it works.
	 */
	it("advertises every verb the handler routes", () => {
		expect(declarationFor("account").subcommands?.map(sub => sub.name)).toEqual([
			"status",
			"manager",
			"switch",
			"use",
			"name",
			"refresh",
			"usage",
			"login",
			"logout",
		]);
	});

	/**
	 * The verbs that take an argument declare their usage, because the palette prints it as the hint
	 * and a verb like `name` is unusable without knowing it takes free text.
	 */
	it("declares the argument shape of every verb that takes one", () => {
		const usages = Object.fromEntries(
			(declarationFor("account").subcommands ?? []).map(sub => [sub.name, sub.usage]),
		);

		expect(usages).toEqual({
			status: undefined,
			manager: undefined,
			switch: "[provider]",
			use: "<provider> <account>",
			name: "<text>",
			refresh: undefined,
			usage: undefined,
			login: "[provider]",
			logout: "[provider]",
		});
	});
});
