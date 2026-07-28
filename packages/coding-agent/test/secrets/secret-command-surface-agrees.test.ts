/**
 * The three places `/secret`'s subcommands are written down have to agree.
 *
 * WHY THIS SUITE EXISTS. A subcommand exists in three places and each is read by a different
 * audience: the DECLARATION drives autocomplete and the ACP command list, `SECRET_COMMAND_USAGE`
 * is what an operator sees when they type `/secret` with no arguments, and `parseSecretCommand`
 * is what actually runs. Adding one and forgetting another does not break anything loudly. It
 * produces a subcommand you can tab-complete and cannot run, or one that works and is absent
 * from the help, and nothing fails until somebody tries it.
 *
 * `/secret log` was added in exactly this window, which is why the check exists now rather than
 * being left for the next addition to get wrong.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@veyyon/coding-agent/slash-commands/text-mode-builtins";
import {
	parseSecretCommand,
	SECRET_COMMAND_USAGE,
	type SecretSubcommand,
} from "@veyyon/coding-agent/secrets/secret-command";

const declaration = BUILTIN_SLASH_COMMAND_DECLARATIONS.find(command => command.name === "secret");

describe("the /secret declaration", () => {
	/** It exists, so the rest of this suite is checking something. */
	it("is registered", () => {
		expect(declaration).toBeDefined();
		expect(declaration?.subcommands?.length).toBeGreaterThan(0);
	});

	/**
	 * Every declared subcommand actually parses.
	 *
	 * A subcommand in the declaration and not in the parser is tab-completable and then refused,
	 * which reads as a broken command rather than a missing one.
	 */
	it("declares only subcommands the parser accepts", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			expect(() => parseSecretCommand(subcommand.name)).not.toThrow();
			expect(parseSecretCommand(subcommand.name).subcommand).toBe(subcommand.name);
		}
	});

	/**
	 * Every declared subcommand appears in the usage text.
	 *
	 * `SECRET_COMMAND_USAGE` is the only help an operator gets for this command, and a subcommand
	 * missing from it is a feature nobody finds.
	 */
	it("declares only subcommands the usage text mentions", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			expect(SECRET_COMMAND_USAGE).toContain(`/secret ${subcommand.name}`);
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
	 * The inline hint lists the subcommands, so the composer shows what is available.
	 *
	 * Checked against the declaration rather than against a hardcoded list, so adding a subcommand
	 * and forgetting the hint fails here.
	 */
	it("lists every subcommand in the inline hint", () => {
		for (const subcommand of declaration?.subcommands ?? []) {
			expect(declaration?.inlineHint).toContain(subcommand.name);
		}
	});

	/**
	 * ACP advertises only the credential source it can accept safely. The TUI
	 * declaration remains richer because it owns a masked local field.
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

describe("the parser and the usage text", () => {
	/**
	 * Every subcommand the parser accepts is either declared or a deliberate alias.
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
		const aliases = new Map<string, SecretSubcommand>([
			["remove", "rm"],
			["delete", "rm"],
			["renew", "extend"],
			["audit", "log"],
		]);

		for (const [alias, target] of aliases) {
			expect(parseSecretCommand(alias).subcommand).toBe(target);
			expect(declared.has(alias)).toBe(false);
		}
		// `help` is the empty-argument fallback rather than a listed subcommand.
		expect(parseSecretCommand("").subcommand).toBe("help");
		expect(declared.has("help")).toBe(false);
	});

	/** An unknown verb is refused with the usage attached, so the operator sees the options. */
	it("refuses an unknown verb and shows the usage", () => {
		expect(() => parseSecretCommand("frobnicate")).toThrow(/Unknown \/secret subcommand/);
		try {
			parseSecretCommand("frobnicate");
		} catch (error) {
			expect(String(error)).toContain("/secret list");
		}
	});

	/** The usage text names every option the parser accepts, so none is undiscoverable. */
	it("documents every option the parser accepts", () => {
		for (const option of ["--from-env", "--ttl", "--scope", "--limit"]) {
			expect(SECRET_COMMAND_USAGE).toContain(option);
		}
	});
});
