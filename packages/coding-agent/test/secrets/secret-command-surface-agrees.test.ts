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
 * WHAT CHANGED, AND WHY THAT IS NOT DRIFT. The terminal grammar has no verbs at all: the argument
 * line IS the credential, a bare `/secret` opens a masked field, and `manager` is the single
 * reserved word. The verbs survive only where there is no field and no screen to replace them. So
 * the two surfaces genuinely disagree, and the disagreement is the feature — but it is allowed to
 * be EXACTLY two things:
 *   1. the ENTRY GRAMMAR: what an argument line means (a value, or a verb and its options), and
 *   2. the MANAGER: reserved in a terminal, refused by name everywhere else.
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
	type SecretCommandRequest,
	type SecretCommandResult,
	type SecretCommandSurface,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@veyyon/coding-agent/slash-commands/text-mode-builtins";

const declaration = BUILTIN_SLASH_COMMAND_DECLARATIONS.find(command => command.name === "secret");

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
	 * `declaration?.subcommands ?? []`, which an absent declaration satisfies for free. The inventory
	 * is pinned as an exact set rather than a count, because the surface-agreement rows further down
	 * are written against these five verbs: a verb added here without a divergence decision, or one
	 * silently dropped, has to fail at the inventory instead of quietly shrinking the guard.
	 */
	it("is registered", () => {
		expect(declaration?.subcommands?.map(subcommand => subcommand.name)).toEqual([
			"add",
			"list",
			"rm",
			"extend",
			"log",
		]);
	});

	/**
	 * Every declared subcommand actually parses on the surface that has verbs.
	 *
	 * A subcommand in the declaration and not in the parser is listable and then refused, which
	 * reads as a broken command rather than a missing one.
	 */
	it("declares only subcommands the noninteractive parser accepts", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			expect(() => parseSecretCommand(subcommand.name, "noninteractive")).not.toThrow();
			expect(parseSecretCommand(subcommand.name, "noninteractive").subcommand).toBe(subcommand.name);
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
	 * THE INLINE HINT IS THE COMPOSER'S, so it describes the TERMINAL grammar and not the verb list
	 * beside it.
	 *
	 * `inlineHint` is read only by `materializeTuiBuiltinSlashCommand`; ACP is handed `acpInputHint`
	 * instead. It is the one string shown to an operator mid-typing, so a verb in it is a word they
	 * would type expecting a command and store as the first bytes of a credential — the original bug
	 * offered back through autocomplete. Asserted in both directions: the three forms a terminal
	 * really has, and no declared verb, matched on a word boundary so a substring cannot hide one.
	 */
	it("hints the terminal forms in the composer, and no verb", () => {
		expect(declaration?.inlineHint).toContain("<value>");
		expect(declaration?.inlineHint).toContain("manager");
		expect(declaration?.inlineHint).toContain("--from-env");

		for (const subcommand of declaration?.subcommands ?? []) {
			expect(declaration?.inlineHint).not.toMatch(new RegExp(`\\b${subcommand.name}\\b`, "u"));
		}
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
	 * Every subcommand that surface's parser accepts is either declared or a deliberate alias.
	 *
	 * The other direction of the check. An undeclared verb is not necessarily wrong: `rm` has
	 * `remove` and `delete`, `extend` has `renew`, `log` has `audit`, and those exist because
	 * people reach for them. Pinning the alias set means a NEW undeclared verb is a finding while
	 * the intended ones are not.
	 */
	it("accepts exactly the declared subcommands plus the known aliases", () => {
		// Widened to `Set<string>` deliberately: the declaration's names are typed as the subcommand
		// union, and the whole point here is to ask whether a string that is NOT in that union (an
		// alias, or `help`) is declared.
		const declared = new Set<string>((declaration?.subcommands ?? []).map(subcommand => subcommand.name));
		const aliases: Record<string, SecretSubcommand> = {
			remove: "rm",
			delete: "rm",
			renew: "extend",
			audit: "log",
		};

		for (const [alias, target] of Object.entries(aliases)) {
			expect(parseSecretCommand(alias, "noninteractive").subcommand).toBe(target);
			expect(declared.has(alias)).toBe(false);
		}
		// `help` is the empty-argument fallback rather than a listed subcommand.
		expect(parseSecretCommand("", "noninteractive").subcommand).toBe("help");
		expect(declared.has("help")).toBe(false);
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
 * Every row below is the same fact from a different direction: in a terminal an argument line is a
 * credential, there is exactly one word it does not treat as one, and a client with no field reads
 * that same line as the verb grammar it still has.
 */
describe("what the two surfaces deliberately disagree about", () => {
	/**
	 * THE ENTRY GRAMMAR. Every verb line is a command on the surface with no field, and the literal
	 * bytes of a credential on the surface that has one. `add` is included precisely because its
	 * subcommand name coincides on both sides: the discriminator is `value`, which is set only where
	 * the line was read as data.
	 */
	it("read a verb as a command only where there is no field to open", () => {
		const verbLines: Record<string, SecretSubcommand> = {
			add: "add",
			list: "list",
			"rm TOKEN_NAME": "rm",
			"extend TOKEN_NAME --ttl 7d": "extend",
			"log --limit 5": "log",
			"discard --scope project": "discard",
			help: "help",
		};

		for (const [line, subcommand] of Object.entries(verbLines)) {
			expect(parseSecretCommand(line, "noninteractive").subcommand).toBe(subcommand);
			expect(parseSecretCommand(line, "noninteractive").value).toBeUndefined();
			expect(parseSecretCommand(line, "tui")).toEqual({ subcommand: "add", value: line });
		}
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
	 * THE MANAGER, the one reserved word. It is a screen, so a client with none is told exactly that
	 * rather than that the word does not exist: "unknown subcommand" would send an ACP caller looking
	 * for a typo instead of at the text verbs its own help lists.
	 */
	it("reserve the manager for a terminal, and refuse it by name where there is no screen", () => {
		expect(parseSecretCommand("manager", "tui")).toEqual({ subcommand: "manager" });
		expect(SECRET_COMMAND_USAGE).toContain("/secret manager");

		expect(() => parseSecretCommand("manager", "noninteractive")).toThrow(
			/terminal screen, and this client has none/,
		);
		expect(() => parseSecretCommand("manager", "noninteractive")).not.toThrow(/Unknown \/secret subcommand/);
		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).not.toContain("/secret manager");
	});
});
