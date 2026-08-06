/**
 * A message a text client receives must never name a command that client cannot type.
 *
 * WHAT WENT WRONG. `/compact handoff` refused with "Use `/handoff [focus instructions]` to transfer
 * context to a new session", and `/handoff` declared only `handleTui`. An ACP client was therefore
 * refused and then sent to a command its dispatcher answered `false` for, which forwards the text to
 * the model as prose. Two half-landed changes met: `handoff` was removed as a `/compact` mode and
 * promoted to its own command, and the promotion only ever reached the TUI.
 *
 * WHY THE CONTRACT IS ASSERTED BY RUNNING THE COMMANDS. The rule is about the bytes an operator
 * reads, so the test drives the real ACP dispatcher over every text-mode builtin and inspects what
 * came out. Reading the sources for `/word` would pass on a string no path can emit and fail on a
 * comment, and this repo bans source-grep tests for exactly that reason.
 */

import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import {
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@veyyon/coding-agent/slash-commands/text-mode-builtins";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

const declarations = BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[];

/** Every name a TEXT client cannot dispatch: TUI-only commands and their aliases. */
const TUI_ONLY_NAMES: ReadonlySet<string> = new Set(
	declarations
		.filter(declaration => declaration.textMode !== true)
		.flatMap(declaration => [declaration.name, ...(declaration.aliases ?? [])]),
);

/**
 * A `/name` written in operator-facing prose, matched the way the operator would read it.
 *
 * The trailing boundary keeps `/settings › Interaction` (a settings path) from being confused with
 * anything else and keeps `/loginfo` from reading as `/login`. A sentence that names the SURFACE it
 * belongs to, "sign in with /login in an interactive veyyon session", is deliberately still a match:
 * the caller cannot type it either way, and this test's job is to notice that. Those sentences are
 * therefore held to the same rule and excused explicitly below, by exact text, so a NEW one cannot
 * appear unnoticed.
 */
function commandsNamedIn(text: string): string[] {
	return [...text.matchAll(/\/([a-z][a-z0-9-]*)(?![\w:/-])/g)]
		.map(match => match[1] as string)
		.filter(name => TUI_ONLY_NAMES.has(name));
}

/**
 * Sentences that name a TUI-only command AND, in the same breath, name the surface it lives on plus
 * a remedy the receiving client can perform. Pinned by exact substring rather than by command name,
 * so a new misdirection cannot hide behind an excused one.
 */
const SURFACE_QUALIFIED: readonly string[] = [
	"in an interactive veyyon session",
	"in the TUI client",
	"veyyon config set",
];

function unqualifiedMisdirection(text: string): string[] {
	if (SURFACE_QUALIFIED.some(phrase => text.includes(phrase))) return [];
	return commandsNamedIn(text);
}

function acpRuntime(session: Record<string, unknown> = {}) {
	const said: string[] = [];
	const runtime = {
		session: { isStreaming: false, ...session },
		output: (text: string) => {
			said.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { said, runtime };
}

describe("/handoff is reachable by the clients that are told to use it", () => {
	/**
	 * The seed defect. Before the fix the ACP dispatcher answered `false`, which forwards `/handoff
	 * keep the auth work` to the model as ordinary prose: no handoff, no error, and a reply about a
	 * command the operator thought they had run.
	 */
	it("runs the handoff over ACP and reports the new session", async () => {
		const handoff = vi.fn(async () => ({ document: "the document", savedPath: undefined }));
		const h = acpRuntime({ handoff });

		const result = await executeAcpBuiltinSlashCommand("/handoff keep the auth work", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(handoff).toHaveBeenCalledWith("keep the auth work");
		expect(h.said).toEqual(["New session started with handoff context."]);
	});

	it("names the saved document when the handoff wrote one", async () => {
		const h = acpRuntime({ handoff: async () => ({ document: "d", savedPath: "/tmp/artifacts/handoff-1.md" }) });

		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);

		expect(h.said).toEqual([
			"New session started with handoff context. Handoff document saved to: /tmp/artifacts/handoff-1.md",
		]);
	});

	/** A bare `/handoff` passes no focus text rather than the empty string. */
	it("passes no focus instructions for a bare invocation", async () => {
		const handoff = vi.fn(async () => ({ document: "d" }));
		const h = acpRuntime({ handoff });

		await executeAcpBuiltinSlashCommand("/handoff   ", h.runtime);

		expect(handoff).toHaveBeenCalledWith(undefined);
	});

	/** The same guard the TUI applies, in the same words, because the hazard is the same. */
	it("refuses while a response is streaming, without calling handoff", async () => {
		const handoff = vi.fn();
		const h = acpRuntime({ handoff, isStreaming: true });

		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);

		expect(handoff).not.toHaveBeenCalled();
		expect(h.said).toEqual(["Wait for the current response to finish or abort it before handing off."]);
	});

	/**
	 * `AgentSession.handoff` throws its preconditions. Surfacing the throw is what stops the caller
	 * reading a bare "consumed" as "the handoff happened".
	 */
	it("surfaces a precondition failure instead of reporting a new session", async () => {
		const h = acpRuntime({
			handoff: async () => {
				throw new Error("Nothing to hand off (no messages yet)");
			},
		});

		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);

		expect(h.said).toEqual(["Handoff failed: Nothing to hand off (no messages yet)"]);
	});

	it("reports a cancelled handoff as cancelled rather than as a failure", async () => {
		const h = acpRuntime({ handoff: async () => undefined });

		await executeAcpBuiltinSlashCommand("/handoff", h.runtime);

		expect(h.said).toEqual(["Handoff cancelled"]);
	});

	/** Advertised, so a client can offer it rather than discovering it by accident. */
	it("is advertised to ACP clients with its focus hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "handoff");

		expect(advertised).toEqual({
			name: "handoff",
			description: "Generate a handoff document and continue in a new session",
			input: { hint: "[focus instructions]" },
		});
	});

	/** The TUI keeps its own path: the selector-driven handoff, not the text one. */
	it("still routes the TUI to the interactive handoff controller", async () => {
		const handleHandoffCommand = vi.fn(async () => {});
		const setText = vi.fn();
		const runtime = {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleHandoffCommand,
			} as unknown as InteractiveModeContext,
		};

		expect(await executeBuiltinSlashCommand("/handoff focus here", runtime)).toBe(true);
		expect(handleHandoffCommand).toHaveBeenCalledWith("focus here");
		expect(setText).toHaveBeenCalledWith("");
	});
});

describe("the /compact handoff refusal points at something the caller can run", () => {
	/**
	 * The refusal text and the reachability of what it names are one fact, so they are asserted
	 * together. Re-declaring `handoff` as TUI-only turns this red.
	 */
	it("names /handoff, and /handoff dispatches on the surface that was refused", async () => {
		const refused = acpRuntime({ compact: vi.fn(), getContextUsage: () => undefined });

		await executeAcpBuiltinSlashCommand("/compact handoff keep auth", refused.runtime);

		expect(refused.said.join("\n")).toBe(
			"`handoff` is not a compaction mode. Use `/handoff [focus instructions]` to transfer context to a new session.",
		);

		for (const named of [...refused.said.join("\n").matchAll(/`\/([a-z-]+)/g)].map(match => match[1] as string)) {
			expect(lookupBuiltinSlashCommand(named)?.handle, `/${named} must be dispatchable over ACP`).toBeDefined();
		}
	});
});

/**
 * The general lock.
 *
 * Every text-mode builtin is driven through the real ACP dispatcher with a runtime that fails every
 * precondition, which is how a command reaches its usage and refusal branches without touching the
 * network, a vault or a session file. Whatever it says is then read for `/command` tokens, and any
 * token naming a TUI-only command fails the suite unless the sentence also names the surface or a
 * remedy the caller can perform.
 *
 * COVERAGE IS DECLARED, NOT ASSUMED. A handler that would do real work is listed in
 * `NOT_DRIVEN_HERE` with the reason, and the list is asserted to be exactly right, so a new
 * text-mode command is either driven here or classified deliberately.
 */
const NOT_DRIVEN_HERE: Readonly<Record<string, string>> = {
	prewalk: "resolves a real model through the catalog and the settings store",
	share: "uploads the session to the share server",
	secret: "opens the on-disk vault",
	memory: "constructs the configured memory backend",
	plugins: "lists installed npm plugins from disk",
	"reload-plugins": "clears plugin caches and re-scans the project registry",
	mcp: "connects to configured MCP servers",
	ssh: "reads and writes the ssh host config",
	export: "writes an HTML file",
	move: "relocates the session directory on disk",
	cwd: "stats and re-roots a real directory",
	todo: "reads and writes the persisted todo snapshot",
};

describe("no ACP-visible message names a command ACP cannot dispatch", () => {
	const textModeNames = declarations.filter(d => d.textMode === true).map(d => d.name);
	const driven = textModeNames.filter(name => !(name in NOT_DRIVEN_HERE));

	/** The two halves of the sweep are real: a set of TUI-only names, and commands to drive. */
	it("has both a population to check and a vocabulary to check it against", () => {
		expect(TUI_ONLY_NAMES.size).toBeGreaterThan(30);
		expect(TUI_ONLY_NAMES.has("handoff")).toBe(false);
		expect(driven.length).toBeGreaterThan(15);
	});

	it("classifies every text-mode command as driven or deliberately skipped", () => {
		const stale = Object.keys(NOT_DRIVEN_HERE)
			.filter(name => !textModeNames.includes(name))
			.sort();

		expect(stale, "these are listed as skipped and are no longer text-mode commands").toEqual([]);
	});

	it("says nothing that sends a text client to a TUI-only command", async () => {
		const misdirections: string[] = [];

		for (const name of driven) {
			const spec = lookupBuiltinSlashCommand(name);
			const invocations = spec?.allowArgs ? [`/${name}`, `/${name} zzz-not-a-real-argument`] : [`/${name}`];
			for (const invocation of invocations) {
				const h = acpRuntime({
					compact: async () => {
						throw new Error("no model configured");
					},
					shake: async () => {
						throw new Error("no model configured");
					},
					freshSession: () => undefined,
					getContextUsage: () => undefined,
					getAsyncJobSnapshot: () => undefined,
					getActiveToolNames: () => [],
					getAllToolNames: () => [],
					getAvailableModels: () => [],
					getAvailableThinkingLevels: () => ["low", "high"],
					configuredThinkingLevel: () => undefined,
					formatSessionAsText: () => "",
					handoff: async () => undefined,
					listResetCredits: async () => [],
					setForcedToolChoice: () => {
						throw new Error("no such tool");
					},
					toggleFastMode: () => false,
					isApprovalBypassed: () => false,
					effectiveApprovalMode: () => "auto",
				});
				try {
					await executeAcpBuiltinSlashCommand(invocation, h.runtime);
				} catch (error) {
					// A handler that throws said nothing, so it misdirects nobody. The throw itself is
					// another suite's contract; recording it here would make this one fail on unrelated
					// changes to a stub.
					void error;
				}
				for (const text of h.said) {
					for (const named of unqualifiedMisdirection(text)) {
						misdirections.push(`${invocation} -> /${named}: ${text}`);
					}
				}
			}
		}

		expect(misdirections, "an ACP client is being sent to a command it cannot dispatch").toEqual([]);
	});
});

/**
 * The individual sentences that used to name a TUI-only command and nothing else.
 *
 * The sweep above excuses a sentence that names the surface or a `veyyon config set` remedy, which
 * is what makes it a rule about misdirection rather than about the word `/settings`. These pin the
 * remedy itself, byte for byte, so removing the reachable half turns them red instead of quietly
 * satisfying the sweep's exemption.
 */
describe("an ACP-reachable remedy names something an ACP client can run", () => {
	it("/usage reset with no stored accounts names the surface /login lives on", async () => {
		const h = acpRuntime({ listResetCredits: async () => [] });

		await executeAcpBuiltinSlashCommand("/usage reset", h.runtime);

		expect(h.said).toEqual([
			"No Codex accounts found. Sign in with /login in an interactive veyyon session to add one.",
		]);
	});

	it("/thinking names the config key beside the settings screen", async () => {
		// The ladder comes from the session's own model through formatThinkingLevelChoices,
		// not from a runtime callback, so there is nothing to stub here: what the command
		// offers is what the model accepts.
		const h = acpRuntime({ configuredThinkingLevel: () => undefined });

		await executeAcpBuiltinSlashCommand("/thinking", h.runtime);

		expect(h.said).toEqual([
			"Effort: auto (this session). Choose one of: off, auto, minimal, low, medium, high, xhigh, max. " +
				"Usage: /thinking <level>. " +
				'To change the saved default, use /settings → Model → Default Effort, or run: veyyon config set defaultEffort \'{"*":"high"}\'.',
		]);
	});

	it("/cwd names the config key beside the settings path", async () => {
		const h = acpRuntime();
		const runtime = {
			...h.runtime,
			sessionManager: { getCwd: () => "/work/project" },
		} as unknown as SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/cwd", runtime);

		expect(h.said).toEqual([
			"/work/project\n(session-scoped and ephemeral. For a per-profile default working directory, " +
				"set session.workdir in /settings › Interaction › Profile on this profile, " +
				"or run: veyyon config set session.workdir <path>.)",
		]);
	});
});

describe("every documented alias reaches the handler it claims", () => {
	/**
	 * The aliases a reader would NOT guess, which is what makes them worth naming one by one:
	 * `/status` opens the Extension Control Center rather than a session-status view, `/cockpit` and
	 * `/hub` are the retired Agent Hub names now pointing at the Agent Control Center, and `/help` is
	 * the first thing a new user types. An alias that resolved elsewhere, or to nothing, would send a
	 * reader to a command that errors.
	 *
	 * The predictable aliases (`/models`, `/effort`, `/approval`, `/profiles`) are deliberately NOT
	 * pinned here. They are covered by the sweep below, which reads the registry, and a hand-written
	 * row for one of them once asserted `/approval` before `/permissions` had landed: a test pinning
	 * a command that shipped in no version is worse than no row. `/providers` is absent for the
	 * opposite reason, having stopped being an alias of `/setup` and become a command of its own.
	 */
	it.each([
		["cockpit", "agents"],
		["hub", "agents"],
		["help", "welcome"],
		["status", "extensions"],
	])("resolves /%s to /%s", (alias, target) => {
		const resolved = lookupBuiltinSlashCommand(alias);

		expect(resolved?.name).toBe(target);
		expect(resolved).toBe(lookupBuiltinSlashCommand(target));
	});

	/**
	 * Every alias in the registry, not only the ones spelled out above, and no alias shadowed by a
	 * later command of the same name. The lookup map is filled command by command with each one's
	 * aliases, so a command declared after an alias of that name silently takes the key: that is
	 * exactly what retiring `/providers` as an alias of `/setup` would have done had the alias been
	 * left behind.
	 */
	it("resolves every declared alias to its own command", () => {
		const broken = BUILTIN_SLASH_COMMANDS_INTERNAL.flatMap(spec =>
			(spec.aliases ?? [])
				.filter(alias => lookupBuiltinSlashCommand(alias)?.name !== spec.name)
				.map(alias => `/${alias} should reach /${spec.name}`),
		);

		expect(broken).toEqual([]);
	});

	/**
	 * An alias of a TUI-only command must not be advertised to ACP, and it is not: the
	 * advertisement is built from `textMode` declarations only, and `ACP_BUILTIN_SLASH_COMMANDS`
	 * lists primary names.
	 *
	 * The stronger statement, that everything advertised is dispatchable, is NOT asserted here
	 * because it is a compile-time guarantee rather than a runtime one: `HandlerSetFor` in
	 * `builtin-registry.ts` requires `handle` for a `textMode: true` declaration and forbids it
	 * otherwise, so the two cannot disagree in a tree that typechecks. Restating it at runtime would
	 * duplicate `bun check` and turn any half-landed declaration into a second, less informative red.
	 */
	it("advertises no name that is not a text-mode declaration", () => {
		const textMode = new Set(declarations.filter(d => d.textMode === true).map(d => d.name));

		const strangers = ACP_BUILTIN_SLASH_COMMANDS.map(c => c.name).filter(name => !textMode.has(name));

		expect(strangers, "advertised to ACP without a text-mode declaration").toEqual([]);
	});
});
