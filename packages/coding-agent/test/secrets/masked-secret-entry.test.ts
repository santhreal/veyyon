/**
 * Entering a credential without it ever appearing anywhere.
 *
 * WHY THIS SUITE EXISTS. The obfuscator protects what leaves for the provider. It cannot scrub a
 * terminal, an input buffer, or a session file after the fact, so the only way a typed credential
 * stays private is if it never reaches any of them in the first place. That is a claim about
 * ORDER and ABSENCE, and both are easy to break silently:
 *
 *   - Order: clearing the composer AFTER reading the value leaves the credential in the input
 *     buffer for as long as the prompt is open, and a cancelled prompt leaves it there for good.
 *   - Absence: the value must not appear in the command's output, in the message put in front of
 *     the model, or in the session file. Each is a separate write, and each is asserted against
 *     the value's own bytes rather than against a redaction function having been called.
 *
 * The vault here is REAL, on a temporary directory, because a stubbed vault would not prove that
 * what lands on disk is the credential while what lands everywhere else is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { NONINTERACTIVE_SECRET_COMMAND_USAGE, SECRET_COMMAND_USAGE } from "@veyyon/coding-agent/secrets/secret-command";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import * as secretSurface from "@veyyon/coding-agent/slash-commands/helpers/secret";
import { runSecretCommandForSurface } from "@veyyon/coding-agent/slash-commands/helpers/secret";
import { DEFAULT_MASK_CHAR } from "@veyyon/tui";

/** The credential under test. Long enough to be obfuscatable, distinctive enough to grep for. */
const VALUE = "ghp_maskedEntryTestCredential99";

let home: string;
let project: string;

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-masked-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-masked-proj-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

/** Everything the port writes anywhere, so absence can be asserted over all of it at once. */
interface Harness {
	agentMessages: unknown[];
	sessionMessages: unknown[];
	obfuscator: SecretObfuscator;
	prompted: string[];
	/** Every `settings.set` the command performed, in order, so a write can be asserted exactly. */
	settingWrites: Array<{ key: string; value: unknown }>;
	/** The `settings.set` keys observed at each `flush`, proving a write reached durable storage. */
	settingFlushes: Array<string[]>;
	port: Parameters<typeof runSecretCommandForSurface>[1];
}

function harness(options?: {
	promptReturns?: string | undefined;
	secretsEnabled?: boolean;
	defaultTtl?: string;
	interactive?: boolean;
	liveObfuscator?: boolean;
}): Harness {
	const agentMessages: unknown[] = [];
	const sessionMessages: unknown[] = [];
	const obfuscator = new SecretObfuscator([]);
	const prompted: string[] = [];
	const settingValues: Record<string, unknown> = {
		"secrets.enabled": options?.secretsEnabled ?? true,
		"secrets.auditLog": true,
		"secrets.defaultTtl": options?.defaultTtl ?? "1d",
	};
	const locations = resolveVaultLocations({
		globalConfigRoot: home,
		agentDir: path.join(home, "profiles", "default"),
		cwd: project,
	});
	const liveObfuscator = options?.liveObfuscator === false ? undefined : obfuscator;
	const session = {
		obfuscator: liveObfuscator,
		secretsEnabled: liveObfuscator !== undefined,
		operatorNotices: new OperatorNotices(),
		agent: { appendMessage: (message: unknown) => agentMessages.push(message) },
		refreshSecrets: async () => {
			if (liveObfuscator === undefined) return;
			const named = await new SecretVault(locations).namedSecrets();
			const liveNames = new Set(named.map(secret => secret.name));
			for (const secret of named) {
				liveObfuscator.addNamedSecret(secret.name, secret.value, secret.expiresAt);
			}
			for (const name of liveObfuscator.namedSecretNames()) {
				if (!liveNames.has(name)) liveObfuscator.forgetNamedSecret(name);
			}
		},
	};

	const settingWrites: Array<{ key: string; value: unknown }> = [];
	/**
	 * Keys captured at each `flush`, so a test can prove the enable was made DURABLE and not merely
	 * queued. The fake carries `flush` because the real `Settings.set` only schedules a debounced
	 * write: a fake without it cannot tell a persisted setting from a lost one.
	 */
	const settingFlushes: Array<string[]> = [];
	return {
		agentMessages,
		sessionMessages,
		obfuscator,
		prompted,
		settingWrites,
		settingFlushes,
		port: {
			session,
			sessionManager: { appendMessage: (message: unknown) => sessionMessages.push(message) },
			settings: {
				get: (key: string) => settingValues[key],
				// Writes are applied to the same map `get` reads, so a later read inside the same
				// command sees what the command just wrote, as the real Settings does.
				set: (key: string, value: unknown) => {
					settingWrites.push({ key, value });
					settingValues[key] = value;
				},
				flush: async () => {
					settingFlushes.push(settingWrites.map(write => write.key));
				},
			},
			cwd: project,
			globalConfigRoot: home,
			agentDir: path.join(home, "profiles", "default"),
			...(options?.interactive === false
				? {}
				: {
						promptForValue: async (name: string | undefined) => {
							prompted.push(name ?? "(unnamed)");
							return options?.promptReturns;
						},
					}),
		} as unknown as Parameters<typeof runSecretCommandForSurface>[1],
	};
}

describe("a value entered through a masked prompt", () => {
	/** The prompt is opened, with the name it is for, so the operator knows what they are pasting. */
	it("prompts when no value and no source were given", async () => {
		const h = harness({ promptReturns: VALUE });

		await runSecretCommandForSurface("add github-token", h.port);

		// NORMALISED, not as typed: the prompt names the secret the way the model will see it, so
		// `github-token` is shown as GITHUB_TOKEN rather than teaching a placeholder that does not
		// exist.
		expect(h.prompted).toEqual(["GITHUB_TOKEN"]);
	});

	/** `--from-env` needs no prompt, so the safe non-interactive form is not made harder. */
	it("does not prompt when the value comes from the environment", async () => {
		process.env.VEYYON_MASKED_TEST_TOKEN = VALUE;
		try {
			const h = harness();
			await runSecretCommandForSurface("add github-token --from-env VEYYON_MASKED_TEST_TOKEN", h.port);

			expect(h.prompted).toEqual([]);
		} finally {
			delete process.env.VEYYON_MASKED_TEST_TOKEN;
		}
	});

	/**
	 * THE ABSENCE PROPERTY. The value is on disk in the vault and nowhere else.
	 *
	 * Checked over the command's output, the message put in front of the model, and the message
	 * written to the session file, because those are three separate writes and any one of them
	 * leaking is a full disclosure.
	 */
	it("appears in no output, no agent message and no session message", async () => {
		const h = harness({ promptReturns: VALUE });

		const outcome = await runSecretCommandForSurface("add github-token", h.port);

		expect(outcome.message).not.toContain(VALUE);
		expect(JSON.stringify(h.agentMessages)).not.toContain(VALUE);
		expect(JSON.stringify(h.sessionMessages)).not.toContain(VALUE);
		// And no partial leak: no prefix of the credential beyond the harmless `g`.
		for (let end = 4; end <= VALUE.length; end++) {
			expect(outcome.message).not.toContain(VALUE.slice(0, end));
		}
	});

	/** It IS stored, encrypted, so the absence above is privacy and not silent data loss. */
	it("is stored in the vault and readable back", async () => {
		const h = harness({ promptReturns: VALUE });

		await runSecretCommandForSurface("add github-token", h.port);

		const vault = new SecretVault(
			resolveVaultLocations({
				globalConfigRoot: home,
				agentDir: path.join(home, "profiles", "default"),
				cwd: project,
			}),
		);
		const entries = await vault.load();
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("GITHUB_TOKEN");
		expect(entries[0].value).toBe(VALUE);
	});

	/** The vault FILE holds ciphertext, so the value is not sitting in plain text on disk. */
	it("is not stored as plain text on disk", async () => {
		const h = harness({ promptReturns: VALUE });

		await runSecretCommandForSurface("add github-token", h.port);

		const vaultFile = await fs.readFile(path.join(home, "profiles", "default", "vault.json"), "utf8");
		expect(vaultFile).not.toContain(VALUE);
		expect(vaultFile).toContain('"ct"');
	});

	/** The running obfuscator learns it immediately, so the secret works without a restart. */
	it("is protected by the running obfuscator straight away", async () => {
		const h = harness({ promptReturns: VALUE });

		await runSecretCommandForSurface("add github-token", h.port);

		expect(h.obfuscator.hasNamedSecret("GITHUB_TOKEN")).toBe(true);
		expect(h.obfuscator.obfuscate(`token is ${VALUE}`)).toBe("token is #GITHUB_TOKEN#");
	});

	/** The model is told the placeholder exists, in both the live agent and the saved session. */
	it("introduces the placeholder to the model in both places", async () => {
		const h = harness({ promptReturns: VALUE });

		await runSecretCommandForSurface("add github-token", h.port);

		expect(h.agentMessages).toHaveLength(1);
		expect(h.sessionMessages).toHaveLength(1);
		expect(JSON.stringify(h.agentMessages)).toContain("#GITHUB_TOKEN#");
		expect(JSON.stringify(h.sessionMessages)).toContain("#GITHUB_TOKEN#");
	});

	/**
	 * The confirmation does NOT warn about the scrollback, because the value was never on screen.
	 *
	 * A warning that fires when it does not apply is one an operator learns to skip, including on
	 * the inline path where it is true.
	 */
	it("does not warn about a scrollback exposure that did not happen", async () => {
		const h = harness({ promptReturns: VALUE });

		const outcome = await runSecretCommandForSurface("add github-token", h.port);

		expect(outcome.message).not.toContain("scrollback");
		expect(outcome.message).toContain("#GITHUB_TOKEN#");
	});
});

describe("non-interactive secret commands", () => {
	/**
	 * ACP and RPC have no masked terminal. An inline credential would remain in their request
	 * history, so the adapter refuses it without repeating any credential byte.
	 */
	it("refuses ACP/RPC inline credentials without echoing them", async () => {
		const h = harness({ interactive: false });
		const failure = await runSecretCommandForSurface(`add remote-token ${VALUE}`, h.port).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(String(failure)).toContain("--from-env");
		expect(String(failure)).not.toContain(VALUE);
		await expect(fs.stat(path.join(home, "profiles", "default", "vault.json"))).rejects.toThrow();
	});

	/** The documented non-interactive source remains an ordinary successful command. */
	it("accepts --from-env without a terminal", async () => {
		process.env.VEYYON_NONINTERACTIVE_SECRET = VALUE;
		try {
			const h = harness({ interactive: false });
			const outcome = await runSecretCommandForSurface(
				"add remote-token --from-env VEYYON_NONINTERACTIVE_SECRET",
				h.port,
			);
			const vault = new SecretVault(
				resolveVaultLocations({
					globalConfigRoot: home,
					agentDir: path.join(home, "profiles", "default"),
					cwd: project,
				}),
			);

			expect(outcome.message).toContain("#REMOTE_TOKEN#");
			expect((await vault.load())[0].value).toBe(VALUE);
		} finally {
			delete process.env.VEYYON_NONINTERACTIVE_SECRET;
		}
	});

	/**
	 * A missing value in a headless client must not recommend the inline form that the same adapter
	 * refuses. Contradictory recovery instructions turn a safe failure into an unusable loop.
	 */
	it("recommends only --from-env when no noninteractive value was supplied", async () => {
		const failure = await runSecretCommandForSurface("add remote-token", harness({ interactive: false }).port).then(
			() => undefined,
			(error: unknown) => String(error),
		);

		expect(failure).toContain("/secret add REMOTE_TOKEN --from-env MY_TOKEN");
		expect(failure).not.toContain("pass the value directly");
		expect(failure).not.toContain("scrollback");
	});

	/**
	 * Help is capability-aware. Headless clients may advertise environment
	 * lookup and management, but must never teach inline or supposedly-hidden
	 * typing that their transport cannot provide; the TUI retains both forms.
	 */
	it("keeps noninteractive help safe while retaining explicit TUI guidance", async () => {
		const headless = await runSecretCommandForSurface("", harness({ interactive: false }).port);
		const tui = await runSecretCommandForSurface("", harness({ interactive: true }).port);

		expect(headless.message).toBe(NONINTERACTIVE_SECRET_COMMAND_USAGE);
		expect(headless.message).toContain("--from-env");
		expect(headless.message).not.toContain("prompt for the value");
		expect(headless.message).not.toContain("<value>");
		expect(headless.message).not.toContain("visible on screen");

		expect(tui.message).toBe(SECRET_COMMAND_USAGE);
		expect(tui.message).toContain("hidden as you type");
		expect(tui.message).toContain("<value>");
		expect(tui.message).toContain("visible on screen");
	});

	/**
	 * Parser failures use the same surface copy as successful help. Otherwise a
	 * typo in ACP would reintroduce unsafe inline guidance through the error
	 * path even though `/secret` itself looked safe.
	 */
	it("keeps noninteractive parse errors free of unsafe credential forms", async () => {
		const failure = await runSecretCommandForSurface("unknown-subcommand", harness({ interactive: false }).port).then(
			() => undefined,
			(error: unknown) => String(error),
		);

		expect(failure).toContain("--from-env");
		expect(failure).not.toContain("prompt for the value");
		expect(failure).not.toContain("<value>");
		expect(failure).not.toContain("visible on screen");
	});
});

describe("default lifetime resolution at the surface", () => {
	/**
	 * A malformed default matters only when a command needs that default. Read-only commands and
	 * help remain available; removal still fails honestly when its target is absent, but never
	 * because the unrelated lifetime setting was parsed.
	 */
	it("does not resolve a malformed default for help, list, log or rm", async () => {
		const h = harness({ defaultTtl: "not-a-lifetime" });

		for (const args of ["help", "list", "log"]) {
			await expect(runSecretCommandForSurface(args, h.port)).resolves.toHaveProperty("message");
		}
		await expect(runSecretCommandForSurface("rm absent-token", h.port)).rejects.toThrow(
			"No secret named ABSENT_TOKEN is stored. Run /secret list to see what is.",
		);
	});

	/**
	 * A malformed default must be rejected before opening the masked field. Asking for sensitive
	 * bytes and only then discovering unrelated configuration is invalid loses the credential and
	 * invites a needless second paste.
	 */
	it("validates the default lifetime before prompting for a value", async () => {
		const h = harness({ defaultTtl: "not-a-lifetime", promptReturns: VALUE });

		await expect(runSecretCommandForSurface("add prompt-token", h.port)).rejects.toThrow(
			/The secrets\.defaultTtl setting/,
		);
		expect(h.prompted).toEqual([]);
		await expect(fs.stat(path.join(home, "profiles", "default", "vault.json"))).rejects.toThrow();
	});

	/** An explicit lifetime is complete input and must not consult a contradictory default. */
	it("does not resolve a malformed default when TTL is explicit", async () => {
		process.env.VEYYON_EXPLICIT_TTL_SECRET = VALUE;
		try {
			const h = harness({ defaultTtl: "not-a-lifetime" });

			await expect(
				runSecretCommandForSurface("add explicit-token --from-env VEYYON_EXPLICIT_TTL_SECRET --ttl never", h.port),
			).resolves.toHaveProperty("message");
			await expect(runSecretCommandForSurface("extend explicit-token --ttl 7d", h.port)).resolves.toHaveProperty(
				"message",
			);
		} finally {
			delete process.env.VEYYON_EXPLICIT_TTL_SECRET;
		}
	});
});

describe("live obfuscator reconciliation", () => {
	/**
	 * Settings are a snapshot; the live obfuscator is the confidentiality boundary. If it exists,
	 * a changed vault must reconcile into it even while the snapshot still says disabled.
	 */
	it("reconciles an existing obfuscator when the setting snapshot says disabled", async () => {
		const h = harness({ promptReturns: VALUE, secretsEnabled: false });

		const outcome = await runSecretCommandForSurface("add live-token", h.port);

		expect(h.obfuscator.hasNamedSecret("LIVE_TOKEN")).toBe(true);
		expect(outcome.message).not.toContain("protection is OFF");
	});

	/**
	 * The converse must also fail closed: an enabled snapshot cannot pretend protection is live
	 * when this session has no obfuscator to reconcile.
	 */
	it("reports protection off when the enabled snapshot has no live obfuscator", async () => {
		process.env.VEYYON_NO_LIVE_OBFUSCATOR = VALUE;
		try {
			const h = harness({ interactive: false, secretsEnabled: true, liveObfuscator: false });

			const outcome = await runSecretCommandForSurface(
				"add dormant-token --from-env VEYYON_NO_LIVE_OBFUSCATOR",
				h.port,
			);

			expect(outcome.message).toContain("protection is OFF");
			expect(h.obfuscator.hasNamedSecret("DORMANT_TOKEN")).toBe(false);
			expect(h.agentMessages).toHaveLength(0);
		} finally {
			delete process.env.VEYYON_NO_LIVE_OBFUSCATOR;
		}
	});

	/**
	 * A refresh can fail after the encrypted write is durable. The surfaced error must name that
	 * split outcome so callers do not retry an add believing nothing changed.
	 */
	it("reports a durable vault update when live reconciliation fails", async () => {
		const h = harness({ promptReturns: VALUE });
		h.port.session.refreshSecrets = async () => {
			throw new Error("reload failed");
		};

		const failure = await runSecretCommandForSurface("add durable-token", h.port).then(
			() => undefined,
			(error: unknown) => error,
		);
		const vault = new SecretVault(
			resolveVaultLocations({
				globalConfigRoot: home,
				agentDir: path.join(home, "profiles", "default"),
				cwd: project,
			}),
		);

		expect((failure as Error).message).toBe(
			"The vault was updated, but the running session could not refresh secret protection: reload failed",
		);
		expect((await vault.load()).find(entry => entry.name === "DURABLE_TOKEN")?.value).toBe(VALUE);
	});

	/**
	 * Conversation persistence runs after storage and live refresh. If it fails, the error must
	 * disclose the completed state transition so retry logic does not rotate the secret by mistake.
	 */
	it("reports a durable protected update when the model notice cannot be saved", async () => {
		const h = harness({ promptReturns: VALUE });
		h.port.sessionManager.appendMessage = () => {
			throw new Error("session append failed");
		};

		const failure = await runSecretCommandForSurface("add notice-token", h.port).then(
			() => undefined,
			(error: unknown) => error,
		);
		const vault = new SecretVault(
			resolveVaultLocations({
				globalConfigRoot: home,
				agentDir: path.join(home, "profiles", "default"),
				cwd: project,
			}),
		);

		expect((failure as Error).message).toBe(
			"The vault was updated and secret protection refreshed, but the model notice could not be saved: " +
				"session append failed",
		);
		expect(h.obfuscator.hasNamedSecret("NOTICE_TOKEN")).toBe(true);
		expect((await vault.load()).find(entry => entry.name === "NOTICE_TOKEN")?.value).toBe(VALUE);
	});
});

describe("a cancelled masked prompt", () => {
	/** Stores nothing, and says so, rather than storing an empty secret. */
	it("stores nothing when escape is pressed", async () => {
		const h = harness({ promptReturns: undefined });

		const outcome = await runSecretCommandForSurface("add github-token", h.port);

		expect(outcome.cancelled).toBe(true);
		expect(outcome.message).toContain("Nothing was stored");
		expect(h.agentMessages).toHaveLength(0);
		expect(h.obfuscator.hasNamedSecret("GITHUB_TOKEN")).toBe(false);
	});

	/** An empty submission is a cancellation too, not a zero-length credential. */
	it("stores nothing when nothing was typed", async () => {
		const h = harness({ promptReturns: "" });

		const outcome = await runSecretCommandForSurface("add github-token", h.port);

		expect(outcome.cancelled).toBe(true);
		expect(outcome.message).toContain("nothing was stored");
		expect(h.obfuscator.hasNamedSecret("GITHUB_TOKEN")).toBe(false);
	});

	/** No vault file is created at all, so a cancelled add leaves no trace. */
	it("writes no vault file", async () => {
		const h = harness({ promptReturns: undefined });

		await runSecretCommandForSurface("add github-token", h.port);

		await expect(fs.stat(path.join(home, "profiles", "default", "vault.json"))).rejects.toThrow();
	});
});

describe("the TUI path", () => {
	/**
	 * THE ORDER PROPERTY. The composer is cleared BEFORE the masked field opens, and cancellation
	 * stays quiet instead of rendering a successful-looking completion status.
	 *
	 * Clearing afterwards would leave the credential in the input buffer for the life of the
	 * prompt, and a cancelled prompt would leave it there permanently. A cancellation is already
	 * visible in the dialog closing, so an extra status line is stale surface noise.
	 */
	it("clears the composer before reading the value", async () => {
		const order: string[] = [];
		const setText = vi.fn(() => order.push("clear"));
		const showHookInput = vi.fn(async () => {
			order.push("prompt");
			return undefined;
		});
		const showStatus = vi.fn();

		const handled = await executeBuiltinSlashCommand("/secret add github-token", {
			ctx: {
				editor: { setText },
				showHookInput,
				showStatus,
				showWarning: vi.fn(),
				session: { obfuscator: undefined, operatorNotices: new OperatorNotices(), agent: {} },
				sessionManager: { getCwd: () => project, appendMessage: vi.fn() },
				settings: { get: () => undefined },
			} as unknown as InteractiveModeContext,
		});

		expect(handled).toBe(true);
		expect(order).toEqual(["clear", "prompt"]);
		expect(showStatus).not.toHaveBeenCalled();
	});

	/** The field is masked. A prompt that echoes is the exposure this path exists to remove. */
	it("opens the field with a mask", async () => {
		const showHookInput = vi.fn(async () => undefined);

		await executeBuiltinSlashCommand("/secret add github-token", {
			ctx: {
				editor: { setText: vi.fn() },
				showHookInput,
				showStatus: vi.fn(),
				showWarning: vi.fn(),
				session: { obfuscator: undefined, operatorNotices: new OperatorNotices(), agent: {} },
				sessionManager: { getCwd: () => project, appendMessage: vi.fn() },
				settings: { get: () => undefined },
			} as unknown as InteractiveModeContext,
		});

		expect(showHookInput).toHaveBeenCalledTimes(1);
		const [title, placeholder, inputOptions] = showHookInput.mock.calls[0] as unknown as [
			string,
			undefined,
			{ mask?: string },
		];
		expect(inputOptions.mask).toBe(DEFAULT_MASK_CHAR);
		expect(placeholder).toBeUndefined();
		// The title says what happens to what is typed, so the operator is not guessing.
		expect(title).toContain("GITHUB_TOKEN");
		expect(title).toContain("hidden as you type");
	});

	/**
	 * An unusable name is refused BEFORE the credential is asked for.
	 *
	 * Prompting first would take a live credential into memory and then throw the request away over
	 * a name, which is the one ordering that wastes a real secret.
	 */
	it("refuses an unusable name without asking for a value", async () => {
		const showHookInput = vi.fn(async () => undefined);
		const showWarning = vi.fn();

		await executeBuiltinSlashCommand("/secret add ab", {
			ctx: {
				editor: { setText: vi.fn() },
				showHookInput,
				showStatus: vi.fn(),
				showWarning,
				session: { obfuscator: undefined, operatorNotices: new OperatorNotices(), agent: {} },
				sessionManager: { getCwd: () => project, appendMessage: vi.fn() },
				settings: { get: () => undefined },
			} as unknown as InteractiveModeContext,
		});

		expect(showHookInput).not.toHaveBeenCalled();
		expect(String(showWarning.mock.calls[0][0])).toContain("not a usable secret name");
	});

	/** A subcommand that needs no credential does not open a prompt. */
	it("does not prompt for /secret list", async () => {
		const showHookInput = vi.fn(async () => undefined);
		const showStatus = vi.fn();
		const realRunSecretCommand = runSecretCommandForSurface;
		const isolatedPort = harness().port;
		const surfaceSpy = vi
			.spyOn(secretSurface, "runSecretCommandForSurface")
			.mockImplementation(args => realRunSecretCommand(args, isolatedPort));

		await executeBuiltinSlashCommand("/secret list", {
			ctx: {
				editor: { setText: vi.fn() },
				showHookInput,
				showStatus,
				showWarning: vi.fn(),
				session: { obfuscator: undefined, operatorNotices: new OperatorNotices(), agent: {} },
				sessionManager: { getCwd: () => project, appendMessage: vi.fn() },
				settings: { get: () => undefined },
			} as unknown as InteractiveModeContext,
		});
		surfaceSpy.mockRestore();

		expect(showHookInput).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalled();
	});
});

/**
 * Storing a credential is the opt-in, so `/secret add` turns protection on.
 *
 * WHY THIS SUITE EXISTS. `secrets.enabled` ships off. Before this, the first `/secret add` on a
 * fresh install stored the value, printed "the model sees #NAME#, write that placeholder where the
 * credential goes", and then did nothing at all: no substitution, no redaction, until the operator
 * went looking for a checkbox in `/settings`. The feature's own confirmation described behaviour
 * the operator did not have. Asking someone to confirm the thing they just asked for is not a
 * safety property, and the direction of the change is the safe one, since enabling can only ever
 * hide more.
 *
 * The write is announced rather than quiet, because it also changes what happens to environment
 * variables and `secrets.yml`, and a setting that changes itself without saying so is its own bug.
 */
describe("storing a credential while protection is off", () => {
	/** The exact write: one setting, one value, on the add path. */
	it("turns secret protection on", async () => {
		const h = harness({ promptReturns: VALUE, secretsEnabled: false });

		await runSecretCommandForSurface("add first-token", h.port);

		expect(h.settingWrites).toEqual([{ key: "secrets.enabled", value: true }]);
	});

	/**
	 * The enable must be FLUSHED, not merely queued. `Settings.set` schedules a debounced write, so
	 * before this the setting was lost whenever the surface exited inside the debounce window: a
	 * `-p` run, an ACP request, any non-interactive client. Driving the real CLI showed the shape of
	 * the bug exactly: `/secret add` said protection was "saved for the next one", and the very next
	 * process reported protection OFF with the credential already in the vault, which is the one
	 * state this feature exists to prevent. Asserting the flush happened AFTER the write is the
	 * whole contract, so the ordering is pinned rather than just the call count.
	 */
	it("flushes the enable to disk instead of leaving it queued", async () => {
		const h = harness({ promptReturns: VALUE, secretsEnabled: false });

		await runSecretCommandForSurface("add first-token", h.port);

		expect(h.settingFlushes).toEqual([["secrets.enabled"]]);
	});

	/**
	 * A flush that fails must not be reported as a save. The confirmation is the only place the
	 * operator learns whether protection survives a restart, so overstating it strands them in the
	 * exact state they think they escaped: a stored credential with protection off next launch.
	 */
	it("admits when the enable could not be persisted", async () => {
		const h = harness({ promptReturns: VALUE, secretsEnabled: false });
		h.port.settings.flush = async () => {
			throw new Error("read-only file system");
		};

		const outcome = await runSecretCommandForSurface("add first-token", h.port);

		expect(outcome.message).toContain("it is now on for this session, but it could not be saved");
		expect(outcome.message).toContain("read-only file system");
		expect(outcome.message).not.toContain("saved for the next one.");
	});

	/** Announced in the confirmation, on its own line, so the operator knows the state changed. */
	it("says so in the confirmation", async () => {
		const h = harness({ promptReturns: VALUE, secretsEnabled: false });

		const outcome = await runSecretCommandForSurface("add first-token", h.port);

		expect(outcome.message).toContain("Stored FIRST_TOKEN");
		expect(outcome.message).toContain(
			"Secret protection was off, so it is now on for this session and saved for the next one.",
		);
	});

	/** Already on is left alone. A no-op write would still fire settings hooks and a background save. */
	it("writes nothing when protection is already on", async () => {
		const h = harness({ promptReturns: VALUE, secretsEnabled: true });

		const outcome = await runSecretCommandForSurface("add second-token", h.port);

		expect(h.settingWrites).toEqual([]);
		expect(outcome.message).not.toContain("Secret protection was off");
	});

	/**
	 * Only `add` enables. Listing is a read, and `rm` is the operator reducing what is stored: an
	 * `/secret rm` that switched protection on would be the command doing the opposite of what it
	 * says. A cancelled prompt stores nothing, so it changes nothing either.
	 */
	it("leaves the setting alone for every other subcommand", async () => {
		for (const args of ["list", "rm missing-token", "log"]) {
			const h = harness({ secretsEnabled: false });
			await runSecretCommandForSurface(args, h.port).catch(() => undefined);
			expect(h.settingWrites).toEqual([]);
		}
	});

	/** A cancelled masked prompt stores nothing, so there is nothing to enable protection for. */
	it("leaves the setting alone when the prompt is cancelled", async () => {
		const h = harness({ promptReturns: undefined, secretsEnabled: false });

		const outcome = await runSecretCommandForSurface("add cancelled-token", h.port);

		expect(outcome.cancelled).toBe(true);
		expect(h.settingWrites).toEqual([]);
	});

	/**
	 * The fail-closed half. Enabling the setting is not the same as the runtime honouring it, and
	 * the message the operator gets has to reflect the runtime rather than the write. A session with
	 * no live obfuscator still says protection is off, even though the setting was just turned on.
	 */
	it("still reports protection off when the runtime refuses the setting", async () => {
		process.env.VEYYON_AUTO_ENABLE_REFUSED = VALUE;
		try {
			const h = harness({ interactive: false, secretsEnabled: false, liveObfuscator: false });

			const outcome = await runSecretCommandForSurface(
				"add refused-token --from-env VEYYON_AUTO_ENABLE_REFUSED",
				h.port,
			);

			expect(h.settingWrites).toEqual([{ key: "secrets.enabled", value: true }]);
			expect(outcome.message).toContain("Secret protection is OFF");
		} finally {
			delete process.env.VEYYON_AUTO_ENABLE_REFUSED;
		}
	});
});
