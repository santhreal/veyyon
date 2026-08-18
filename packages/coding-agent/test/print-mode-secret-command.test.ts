/**
 * Print mode is a noninteractive command surface, not a shortcut around slash
 * dispatch. These tests use the real ACP builtin registry and a real encrypted
 * vault so a consumed `/secret` command is proven absent from model prompts and
 * present in storage, while every captured output byte is checked for leakage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PrintModeOptions, runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SecretCommandPort } from "@veyyon/coding-agent/slash-commands/helpers/secret";
import * as secretHelper from "@veyyon/coding-agent/slash-commands/helpers/secret";

interface PrintHarness {
	session: AgentSession;
	prompt: (...args: unknown[]) => Promise<void>;
	options: PrintModeOptions["commandRuntime"];
	cwd: string;
	agentDir: string;
	/** Every `settings.set` the run performed, so the protection write can be asserted exactly. */
	settingWrites: Array<{ key: string; value: unknown }>;
}

interface RestorableMock {
	mockRestore(): void;
}

let root = "";
let stdout: string[];
let stderr: string[];
let ownedMocks: RestorableMock[];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-print-secret-"));
	stdout = [];
	stderr = [];
	ownedMocks = [];
	ownedMocks.push(
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			if (typeof args[0] === "string" && args[0].length > 0) stdout.push(args[0]);
			const callback = args[args.length - 1];
			if (typeof callback === "function") callback();
			return true;
		}),
	);
	ownedMocks.push(
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}),
	);
});

afterEach(async () => {
	for (const mock of ownedMocks.reverse()) mock.mockRestore();
	delete process.env.VEYYON_PRINT_SECRET_ENV;
	await fs.rm(root, { recursive: true, force: true });
});

function createHarness(): PrintHarness {
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const prompt = vi.fn(async () => {});
	const sessionManager = {
		getHeader: () => null,
		getCwd: () => cwd,
		appendMessage: vi.fn(),
	};
	// `secrets.enabled` is absent here, which is the shipped default, so a `/secret add` through
	// this harness exercises the path that turns protection on. The stub records the write into the
	// same map `get` reads, so the command sees its own effect exactly as the real Settings shows it.
	const settingValues: Record<string, unknown> = { "secrets.auditLog": false, "secrets.defaultTtl": "1d" };
	const settingWrites: Array<{ key: string; value: unknown }> = [];
	const settings = {
		get: (key: string) => settingValues[key],
		set: (key: string, value: unknown) => {
			settingWrites.push({ key, value });
			settingValues[key] = value;
		},
	};
	const session = {
		subscribe: () => () => {},
		prompt,
		dispose: vi.fn(async () => {}),
		displayAssistantContent: (content: unknown) => content,
		// `--mode json` re-redacts every stdout line through this. Identity here on
		// purpose: these tests assert that a credential passed as a COMMAND ARGUMENT is
		// refused before it is ever stored, so nothing in them has a placeholder to
		// redact back and an identity keeps the refusal the only thing under test.
		obfuscateProviderText: (text: string) => text,
		state: { messages: [] },
		sessionManager,
		settings,
		extensionRunner: undefined,
		operatorNotices: undefined,
		refreshSecrets: vi.fn(async () => {}),
		secretsEnabled: true,
		agent: { appendMessage: vi.fn() },
	} as unknown as AgentSession;
	const realRunSecretCommand = secretHelper.runSecretCommandForSurface;
	const isolatedPort: SecretCommandPort = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		cwd,
		globalConfigRoot: root,
		agentDir,
	};
	ownedMocks.push(
		vi
			.spyOn(secretHelper, "runSecretCommandForSurface")
			.mockImplementation(args => realRunSecretCommand(args, isolatedPort)),
	);
	return {
		session,
		prompt,
		cwd,
		agentDir,
		settingWrites,
		options: {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd,
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

describe("print-mode builtin secret dispatch", () => {
	/**
	 * Positive path: the environment-backed initial command is handled before
	 * prompt dispatch, writes the exact environment value to the real vault and
	 * never starts a model turn.
	 */
	it("consumes and stores an initial --from-env command without prompting the model", async () => {
		const credential = "print-env-secret\twith-byte-boundary  ";
		process.env.VEYYON_PRINT_SECRET_ENV = credential;
		const h = createHarness();

		await runPrintMode(h.session, {
			mode: "text",
			initialMessage: "/secret from-env VEYYON_PRINT_SECRET_ENV PRINT_TOKEN",
			commandRuntime: h.options,
		});

		const vault = new SecretVault(
			resolveVaultLocations({ globalConfigRoot: root, agentDir: h.agentDir, cwd: h.cwd }),
		);
		expect(h.prompt).not.toHaveBeenCalled();
		expect(stdout.join("")).toContain("#PRINT_TOKEN#");
		expect((await vault.load()).find(entry => entry.name === "PRINT_TOKEN")?.value).toBe(credential);
		expect(stdout.join("")).not.toContain(credential);
		expect(stderr.join("")).not.toContain(credential);
		// Storing a credential from a non-interactive surface turns protection on too, and says so:
		// a print-mode caller that stored a value and got no substitution would be the same dead end
		// the TUI had.
		expect(h.settingWrites).toEqual([{ key: "secrets.enabled", value: true }]);
		expect(stdout.join("")).toContain("Secret protection was off");
	});

	/**
	 * Negative/adversarial path: additional messages pass through the same gate. Inline credential
	 * bytes are refused without prompt or echo, and the rejected promise gives the CLI an honest
	 * failing exit path instead of disguising the error as successful command output.
	 */
	it.each(["text", "json"] as const)(
		"fails a secret-bearing additional message without leakage in %s mode",
		async mode => {
			const credential = "INLINE_PRINT_SECRET_93\ttrail  ";
			const h = createHarness();

			const failure = await runPrintMode(h.session, {
				mode,
				messages: [`/secret add PRINT_TOKEN ${credential}`],
				commandRuntime: h.options,
			}).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(h.prompt).not.toHaveBeenCalled();
			expect(failure).toBeInstanceOf(Error);
			// The refusal names the environment form and the whole usage text, and echoes NEITHER word
			// after `add`: nothing distinguishes a name followed by a credential from a credential whose
			// first word looks like a name, so a message that quoted the part it thought was the name
			// would sooner or later quote the credential.
			expect((failure as Error).message).toContain(
				"This client refuses an inline credential, because the line carrying it is retained in the client's own " +
					"request history. Nothing was stored. Read the value out of the environment instead: " +
					"/secret from-env MY_TOKEN <name>.",
			);
			expect((failure as Error).message).toContain("/secret from-env <VAR> <name>");
			expect((failure as Error).message).not.toContain("PRINT_TOKEN");
			expect((failure as Error).message).not.toContain(credential);
			expect(stdout.join("")).toBe("");
			expect(stderr.join("")).not.toContain(credential);
		},
	);
});
