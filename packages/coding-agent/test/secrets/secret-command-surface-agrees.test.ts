/**
 * `/secret` has TWO grammars now, and this suite is about where they are allowed to differ.
 *
 * WHY THIS SUITE EXISTS. A subcommand is written down in several places and each is read by a
 * different audience: the DECLARATION drives the ACP command listing, `NONINTERACTIVE_SECRET_-
 * COMMAND_USAGE` is what a headless client sees when it runs `/secret` with no arguments, and
 * `parseSecretCommand(args, "noninteractive")` is what actually runs. Adding one and forgetting
 * another does not break anything loudly. It produces a subcommand a client can list and cannot
 * run, or one that works and is absent from the help, and nothing fails until somebody tries it.
 *
 * WHAT THE SURFACES ARE ALLOWED TO DISAGREE ABOUT: ONE THING, the ENTRY GRAMMAR. In a terminal the
 * argument line can BE the credential, a bare `/secret` opens a masked field, and the first word
 * decides between the two readings. A client with no field cannot accept a typed value at all, so
 * there the first word is always a verb and a credential arrives only through `--from-env`.
 *
 * No VERB is surface-only. Every word the parser reserves runs on both, which is what makes a rule
 * proved over this grammar a rule about the whole command rather than about one client.
 *
 * Everything else must still be one implementation seen from two places: a lifetime means the same
 * span, a scope means the same file, the same bytes get stored under the same name, and neither
 * surface ever prints a credential. `parseSecretCommand` is the only function that reads `surface`
 * for anything but help copy, which is what makes that provable rather than aspirational — so any
 * OTHER divergence found below is a bug, not a second design.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	NONINTERACTIVE_SECRET_COMMAND_USAGE,
	parseSecretCommand,
	runSecretCommand,
	SECRET_COMMAND_USAGE,
	SECRET_TUI_SUBCOMMANDS,
	SECRET_VERB_SPELLINGS,
	type SecretCommandRequest,
	type SecretCommandResult,
	type SecretCommandSurface,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@veyyon/coding-agent/slash-commands/text-mode-builtins";

const declaration = BUILTIN_SLASH_COMMAND_DECLARATIONS.find(command => command.name === "secret");

/**
 * The rest of a line that satisfies each subcommand's shape, so a refusal is never about arity.
 *
 * Keyed by SUBCOMMAND rather than by spelling, because the alias rows below need the shape of the
 * verb an alias REACHES: `move` is `scope`, which takes a destination, and a bare `move` refuses
 * for a reason that says nothing about whether the word routed.
 */
const WELL_FORMED_REMAINDER: Record<SecretSubcommand, string> = {
	add: "SOME_NAME --from-env VEYYON_SURFACE_AGREES_VALUE",
	list: "",
	rm: "SOME_NAME",
	// A scope, on `discard`'s terms: the verb takes no bare word, and omitting the flag is refused
	// rather than defaulted, so a well-formed line has to name the vault.
	clear: "--scope project",
	rename: "SOME_NAME OTHER_NAME",
	value: "SOME_NAME",
	scope: "SOME_NAME global",
	copy: "SOME_NAME",
	extend: "SOME_NAME --ttl 7d",
	log: "",
	discard: "--scope project",
	help: "",
};

/** Fixed clock, so two vaults written a millisecond apart still hold byte-identical entries. */
const NOW = 1_800_000_000_000;
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;

/** Distinctive enough that a leak into any message is unmistakable, long enough to be storable. */
const VALUE = "ghp_surfaceAgreementCredential77";

/**
 * The variable the shared entry form reads. Unique to this file, set per test, and removed in
 * `afterEach` so no other suite can observe it.
 */
const ENV_VAR = "VEYYON_SURFACE_AGREES_VALUE";

const roots: string[] = [];

afterEach(async () => {
	delete process.env[ENV_VAR];
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** One throwaway vault, so each surface writes its own files and the two can be compared. */
async function freshVault(): Promise<SecretVault> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-surface-agrees-"));
	roots.push(root);
	return new SecretVault(
		{
			globalConfigRoot: path.join(root, "config"),
			profileDir: path.join(root, "config", "profiles", "work", "agent"),
			projectDir: path.join(root, "project", ".veyyon"),
		},
		() => NOW,
	);
}

/** Dispatch one request against one vault, as `surface` would. */
async function run(
	vault: SecretVault,
	request: SecretCommandRequest,
	surface: SecretCommandSurface,
): Promise<SecretCommandResult> {
	return await runSecretCommand(request, {
		vault,
		readEnv: name => process.env[name],
		defaultTtl: DEFAULT_TTL,
		now: NOW,
		surface,
	});
}

/**
 * The declaration, which is the NONINTERACTIVE surface's inventory.
 *
 * Its `subcommands` are the ACP command listing, where the verbs are still real commands. The TUI
 * autocomplete deliberately does not complete them: in a terminal they are not commands, they are
 * the first words of a credential. So every row here checks the declaration against the parser and
 * the help that surface is handed.
 */
describe("the /secret declaration", () => {
	/**
	 * THE NON-VACUITY ANCHOR for this whole describe: every test below iterates
	 * `declaration?.subcommands ?? []`, which an absent declaration satisfies for free.
	 *
	 * DERIVED FROM THE PARSER, not written out here, and that is what closes the class. A verb added
	 * to `SECRET_VERB_SPELLINGS` reaches `SECRET_TUI_SUBCOMMANDS` for free, so a hand-written list
	 * here would have gone stale silently and the rows below would have kept passing over whichever
	 * subset somebody remembered. Equality in both directions: a declared word the parser does not
	 * reserve is a listable command that refuses, and a reserved word nobody declared is a working
	 * command no client can discover. The ORDER is asserted too, because these are the two lists an
	 * operator reads side by side (the ACP listing and the composer dropdown) and one of them
	 * shuffling is a diff nobody would otherwise notice.
	 */
	it("is registered", () => {
		expect(declaration?.subcommands?.map(subcommand => subcommand.name)).toEqual(
			SECRET_TUI_SUBCOMMANDS.map(subcommand => subcommand.name),
		);
	});

	/**
	 * Every declared subcommand actually parses on the surface that has verbs.
	 *
	 * A subcommand in the declaration and not in the parser is listable and then refused, which
	 * reads as a broken command rather than a missing one.
	 */
	it("declares only subcommands the noninteractive parser accepts", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			// A well-formed line per verb, so the only thing under test is the routing. A bare `scope`
			// or `discard` refuses on its own grounds, which would have made this row pass through a
			// catch and stop asserting the mapping it exists for.
			const line = `${subcommand.name} ${WELL_FORMED_REMAINDER[subcommand.name as SecretSubcommand]}`.trim();
			expect(parseSecretCommand(line, "noninteractive").subcommand).toBe(subcommand.name);
		}
	});

	/**
	 * Every declared subcommand appears in the usage text of the surface that can run it.
	 *
	 * `NONINTERACTIVE_SECRET_COMMAND_USAGE` is the only help a headless client gets, and a
	 * subcommand missing from it is a feature nobody finds. The TUI text is checked NOT to list
	 * them by the divergence rows below, since there the words are credentials.
	 */
	it("declares only subcommands the noninteractive usage text mentions", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			// `help` is the one exemption, and it is exempt from THIS text only: a help listing that
			// spends a row telling you how to reach the help you are reading is circular. It is still
			// declared and still offered in the dropdown, which is where it is discovered.
			if (subcommand.name === "help") continue;
			expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).toContain(`/secret ${subcommand.name}`);
		}
	});

	/** Each subcommand carries a usage string, since the inline hint is built from them. */
	it("gives every subcommand a description and a usage line", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			expect(subcommand.description.length).toBeGreaterThan(10);
			expect(subcommand.usage).toContain("/secret");
		}
	});

	/**
	 * THE INLINE HINT IS THE COMPOSER'S, and it is the only thing on screen after `/secret ` before
	 * anything is typed, so it has to name both halves of the terminal grammar.
	 *
	 * `inlineHint` is read only by `materializeTuiBuiltinSlashCommand`; ACP is handed `acpInputHint`
	 * instead. A hint naming no verb at all would hide the whole management half of the command
	 * behind `/secret help`, and a hint naming every verb would push the value form off the end of
	 * one line. So it carries the value forms plus the verbs an operator reaches for first, and the
	 * dropdown carries the rest.
	 *
	 * Asserted in both directions: the value forms a terminal has, and that the words it names are
	 * words the parser runs rather than stores.
	 */
	it("hints both the value forms and the verbs in the composer", () => {
		expect(declaration?.inlineHint).toContain("<value>");
		expect(declaration?.inlineHint).toContain("--from-env");

		for (const verb of ["list", "rm", "rename", "extend", "log"]) {
			expect(declaration?.inlineHint).toMatch(new RegExp(`\\b${verb}\\b`, "u"));
		}
		// A word the parser does not reserve would be stored as the first bytes of a credential by
		// the operator who typed it because the composer suggested it.
		expect(declaration?.inlineHint).not.toContain("manager");
	});

	/**
	 * ACP advertises only the credential source it can accept safely.
	 *
	 * The syntax an ACP client puts in front of a user is `input.hint`, and it names `--from-env`
	 * and nothing else: that transport would retain an inline value in its request history, and it
	 * has no field to hide one in. The copy about a hidden field lives on the `add` subcommand
	 * entry, describing what happens when a person runs it locally, and is pinned here so an edit
	 * to one cannot silently move it into the other.
	 */
	it("projects safe ACP copy without weakening TUI autocomplete guidance", () => {
		const acp = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "secret");

		expect(acp?.description).toContain("environment variables");
		expect(acp?.input?.hint).toContain("--from-env");
		expect(acp?.input?.hint).not.toContain("<value>");
		expect(acp?.description).not.toContain("prompt");
		expect(declaration?.subcommands?.find(command => command.name === "add")?.description).toContain(
			"hidden as you type",
		);
	});
});

describe("the noninteractive parser and its usage text", () => {
	/**
	 * Every word the parser reserves is either a declared subcommand or a deliberate second spelling.
	 *
	 * The other direction of the check, and DERIVED from `SECRET_VERB_SPELLINGS` so a spelling added
	 * later is covered here without anybody remembering this file. An alias is a word `SECRET_TUI_-
	 * SUBCOMMANDS` deliberately leaves out (its key differs from the subcommand it reaches), and the
	 * rule is that it must still RUN and must still be absent from the listing: doubling the list
	 * with `remove` beside `rm` would make a small set look like a large one, and the aliases exist
	 * for muscle memory rather than for discovery.
	 *
	 * The set of them is pinned as well, because "every alias runs" is satisfied by having none: a
	 * spelling silently dropped from the table would leave this row green while `/secret remove TOK`
	 * started storing a credential called `remove`.
	 */
	it("runs every alias the table carries, and lists none of them", () => {
		// Widened to `Set<string>` deliberately: the declaration's names are typed as the subcommand
		// union, and the whole point here is to ask whether a string that is NOT in that union is
		// declared.
		const declared = new Set<string>((declaration?.subcommands ?? []).map(subcommand => subcommand.name));
		const aliases = Object.entries(SECRET_VERB_SPELLINGS).filter(([word, subcommand]) => word !== subcommand);

		expect(aliases.map(([word]) => word).sort()).toEqual(
			["audit", "delete", "move", "name", "remove", "renew", "replace"].sort(),
		);
		for (const [alias, target] of aliases) {
			// The remainder is the target's own shape: `move` reaches `scope`, which refuses without a
			// destination, so a bare alias would fail here for a reason that has nothing to do with
			// whether the word routed.
			const line = `${alias} ${WELL_FORMED_REMAINDER[target]}`.trim();
			expect(parseSecretCommand(line, "noninteractive").subcommand).toBe(target);
			expect(declared.has(alias)).toBe(false);
		}
		// `help` is BOTH the empty-argument fallback and a verb of its own, so unlike the aliases it
		// is declared: a client with no field has no other way to ask what the command does.
		expect(parseSecretCommand("", "noninteractive").subcommand).toBe("help");
		expect(declared.has("help")).toBe(true);
	});

	/** An unknown verb is refused with the usage attached, so the operator sees the options. */
	it("refuses an unknown verb and shows the usage", () => {
		expect(() => parseSecretCommand("frobnicate", "noninteractive")).toThrow(/Unknown \/secret subcommand/);
		try {
			parseSecretCommand("frobnicate", "noninteractive");
		} catch (error) {
			expect(String(error)).toContain("/secret list");
		}
	});

	/** The usage text names every option the parser accepts, so none is undiscoverable. */
	it("documents every option the parser accepts", () => {
		for (const option of ["--from-env", "--ttl", "--scope", "--limit"]) {
			expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).toContain(option);
		}
	});
});

/**
 * The half that must NOT have changed, asserted against a real vault on both surfaces.
 *
 * `runSecretCommand` reads `surface` only to pick help and refusal copy, so a request that reaches
 * it means the same thing whichever grammar produced it. These rows are what makes that claim
 * checkable: identical requests, two vaults, and a byte comparison of what landed in each.
 */
describe("what the two surfaces still agree about", () => {
	/**
	 * THE SHARED ENTRY FORM, and the sharpest statement of the agreement: `--from-env VAR` is the
	 * one line both grammars read, and they parse it into the SAME request. Everything downstream
	 * therefore has to produce the same store, the same confirmation and the same model notice, and
	 * the defaults it fell back to — profile scope, the configured lifetime — are the same defaults.
	 */
	it("store the same entry from the one entry form both grammars have", async () => {
		process.env[ENV_VAR] = VALUE;
		const terminalRequest = parseSecretCommand(`--from-env ${ENV_VAR}`, "tui");
		const clientRequest = parseSecretCommand(`add --from-env ${ENV_VAR}`, "noninteractive");
		expect(terminalRequest).toEqual(clientRequest);

		const terminalVault = await freshVault();
		const clientVault = await freshVault();
		const terminal = await run(terminalVault, terminalRequest, "tui");
		const client = await run(clientVault, clientRequest, "noninteractive");

		expect(terminal.message).toBe(client.message);
		expect(terminal.agentNotice).toBe(client.agentNotice);
		expect(await terminalVault.load()).toEqual(await clientVault.load());

		const [entry] = await terminalVault.load();
		expect({ scope: entry?.scope, value: entry?.value, expiresAt: entry?.expiresAt }).toEqual({
			scope: "profile",
			value: VALUE,
			expiresAt: NOW + DEFAULT_TTL,
		});
	});

	/**
	 * A LIFETIME IS A SPAN, not a per-surface convention. `--ttl` is spellable only on the surface
	 * that has options, but the request it produces is dispatched by code neither surface owns, so
	 * both must resolve it to the same instant — and `never` to no instant at all, which is the
	 * value most likely to be special-cased into a difference.
	 */
	it("read a lifetime the same way, whichever surface asked for it", async () => {
		process.env[ENV_VAR] = VALUE;

		for (const [line, expiresAt] of [
			[`add --from-env ${ENV_VAR} --ttl 30m`, NOW + 30 * 60 * 1000],
			[`add --from-env ${ENV_VAR} --ttl never`, null],
		] as const) {
			const request = parseSecretCommand(line, "noninteractive");
			const terminalVault = await freshVault();
			const clientVault = await freshVault();

			const terminal = await run(terminalVault, request, "tui");
			const client = await run(clientVault, request, "noninteractive");

			expect(terminal.message).toBe(client.message);
			expect((await terminalVault.load())[0]?.expiresAt).toBe(expiresAt);
			expect(await terminalVault.load()).toEqual(await clientVault.load());
		}
	});

	/**
	 * A SCOPE IS A FILE. It selects which vault the entry lands in and which entry shadows which,
	 * so a surface that read `project` as anything else would put a credential somewhere the
	 * operator did not ask for and `/secret list` would still look right.
	 */
	it("read a scope the same way, whichever surface asked for it", async () => {
		process.env[ENV_VAR] = VALUE;
		const request = parseSecretCommand(`add --from-env ${ENV_VAR} --scope project`, "noninteractive");
		const terminalVault = await freshVault();
		const clientVault = await freshVault();

		const terminal = await run(terminalVault, request, "tui");
		const client = await run(clientVault, request, "noninteractive");

		expect(terminal.message).toBe(client.message);
		expect((await terminalVault.load())[0]?.scope).toBe("project");
		expect(await terminalVault.load()).toEqual(await clientVault.load());
	});

	/**
	 * NEITHER SURFACE EVER PRINTS THE CREDENTIAL. This is the property the whole feature exists to
	 * hold, so it is asserted per surface rather than inferred from them agreeing: two surfaces can
	 * agree and both be wrong. Checked over the confirmation, the model notice and the `list` table,
	 * and against a prefix as well as the whole value, because a prefix is still a disclosure.
	 */
	it("never print the credential, on either surface", async () => {
		process.env[ENV_VAR] = VALUE;

		for (const surface of ["tui", "noninteractive"] as const) {
			const vault = await freshVault();
			const added = await run(vault, parseSecretCommand(`add --from-env ${ENV_VAR}`, "noninteractive"), surface);
			const listed = await run(vault, parseSecretCommand("list", "noninteractive"), surface);

			for (const text of [added.message, added.agentNotice ?? "", listed.message]) {
				expect(text).not.toContain(VALUE);
				expect(text).not.toContain(VALUE.slice(0, 12));
			}
			expect(listed.message).toContain("#SECRET_1#");
		}
	});
});

/**
 * The half that changed, stated as a closed list.
 *
 * The disagreement used to be the whole verb grammar: in a terminal an argument line was a
 * credential and nothing else, and every verb belonged to the other surface. It is now exactly ONE
 * member wide, `add`, and the first row below is what shrank it: every other verb routes
 * identically wherever it is typed.
 */
describe("what the two surfaces deliberately disagree about", () => {
	/**
	 * THE AGREEMENT THAT REPLACED THE DISAGREEMENT, and the row that proves the terminal has verbs at
	 * all. Each line routes to the same subcommand on both surfaces and reads as data on neither.
	 *
	 * Derived per line rather than asserted once, because a shared parser that regressed on one
	 * branch, which is precisely what shipped, still passes a single-surface row. `value` is asserted
	 * absent because it is the discriminator: it is set only where a line was read as a credential,
	 * and the defect was that in a terminal every one of these lines came back with it set.
	 */
	it("route every verb to the same subcommand on both surfaces", () => {
		// DERIVED over every verb the parser reserves, minus `add`, which is the one deliberate
		// divergence. A hand-written subset was the original mistake in miniature: it named five of
		// the verbs, so `rename`, `value`, `scope` and `copy` could have been terminal-only or
		// client-only and this row would have said the surfaces agreed.
		const verbs = SECRET_TUI_SUBCOMMANDS.map(subcommand => subcommand.name).filter(name => name !== "add");
		expect(verbs.length).toBeGreaterThan(8);

		for (const verb of verbs) {
			const line = `${verb} ${WELL_FORMED_REMAINDER[verb]}`.trim();
			for (const surface of ["noninteractive", "tui"] as const) {
				const request = parseSecretCommand(line, surface);

				expect(request.subcommand).toBe(verb);
				expect(request.value).toBeUndefined();
			}
		}
	});

	/**
	 * `add` IS the disagreement now, and the difference is where the credential may be. A client with
	 * no field takes a name and reads a value only from the environment; a terminal takes the value
	 * itself and asks for the name afterwards. A terminal that read the first word as a name would be
	 * writing a live credential into plaintext metadata, which is the original bug.
	 */
	it("read the word after add as a name only where a value cannot be typed", () => {
		expect(parseSecretCommand("add GITHUB_TOKEN", "noninteractive")).toEqual({
			subcommand: "add",
			name: "GITHUB_TOKEN",
		});
		expect(parseSecretCommand("add GITHUB_TOKEN", "tui")).toEqual({ subcommand: "add", value: "GITHUB_TOKEN" });
	});

	/**
	 * The inverse, and the reason the divergence is safe in this direction: an inline credential is
	 * ordinary input in a terminal and an unknown verb to a client that would keep it in its request
	 * history forever. Neither surface can silently do the other's reading.
	 */
	it("read an inline credential as a value only in a terminal", () => {
		expect(parseSecretCommand("ghp_pastedStraightAfterTheCommand", "tui")).toEqual({
			subcommand: "add",
			value: "ghp_pastedStraightAfterTheCommand",
		});
		expect(() => parseSecretCommand("ghp_pastedStraightAfterTheCommand", "noninteractive")).toThrow(
			/Unknown \/secret subcommand/,
		);
	});

	/**
	 * THE CLASS: no verb belongs to one surface. Every reserved word parses on both, and both help
	 * texts advertise it, so a verb cannot be typeable in a terminal and unknown to an ACP client, or
	 * listed in one help and missing from the other.
	 *
	 * Derived from the parser's own table rather than a list here, so adding a verb that only one
	 * surface accepts turns this red without anyone remembering to extend a fixture. The two entry
	 * forms are what differ, and they are asserted above.
	 */
	it("keep no verb to themselves, in the parser or in the help", () => {
		for (const { name } of SECRET_TUI_SUBCOMMANDS) {
			for (const surface of ["tui", "noninteractive"] as const) {
				let refusal = "";
				try {
					// A verb needing arguments refuses, which still proves the word is reserved. What must
					// never happen is the word being called unknown, or being swallowed as a credential.
					expect(parseSecretCommand(name, surface).value).toBeUndefined();
				} catch (error) {
					refusal = error instanceof Error ? error.message : String(error);
				}
				expect(refusal).not.toContain("Unknown /secret subcommand");
			}
			if (name === "add" || name === "help") continue;
			expect(SECRET_COMMAND_USAGE).toContain(`/secret ${name}`);
			expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).toContain(`/secret ${name}`);
		}
	});
});
