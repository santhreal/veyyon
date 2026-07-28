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
import { runPrintMode, type PrintModeOptions } from "@veyyon/coding-agent/modes/print-mode";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import * as secretHelper from "@veyyon/coding-agent/slash-commands/helpers/secret";
import type { SecretCommandPort } from "@veyyon/coding-agent/slash-commands/helpers/secret";

interface PrintHarness {
	session: AgentSession;
	prompt: (...args: unknown[]) => Promise<void>;
	options: PrintModeOptions["commandRuntime"];
	cwd: string;
	agentDir: string;
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
	const settings = {
		get: (key: string) => {
			if (key === "secrets.auditLog") return false;
			if (key === "secrets.defaultTtl") return "1d";
			return undefined;
		},
	};
	const session = {
		subscribe: () => () => {},
		prompt,
		dispose: vi.fn(async () => {}),
		displayAssistantContent: (content: unknown) => content,
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
			initialMessage: "/secret add PRINT_TOKEN --from-env VEYYON_PRINT_SECRET_ENV",
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
	});

	/**
	 * Negative/adversarial path: additional messages pass through the same gate.
	 * Inline credential bytes are refused without prompt or echo, and JSON mode
	 * emits one independently parseable command_output object rather than prose.
	 */
	it.each(["text", "json"] as const)(
		"refuses a secret-bearing additional message without leakage in %s mode",
		async mode => {
			const credential = "INLINE_PRINT_SECRET_93\ttrail  ";
			const h = createHarness();

			await runPrintMode(h.session, {
				mode,
				messages: [`/secret add PRINT_TOKEN ${credential}`],
				commandRuntime: h.options,
			});

			expect(h.prompt).not.toHaveBeenCalled();
			const output = stdout.join("");
			expect(output).toContain("--from-env");
			expect(output).not.toContain(credential);
			expect(stderr.join("")).not.toContain(credential);
			if (mode === "json") {
				const lines = output.trimEnd().split("\n");
				expect(lines).toHaveLength(1);
				expect(JSON.parse(lines[0] ?? "")).toMatchObject({ type: "command_output" });
			} else {
				expect(() => JSON.parse(output)).toThrow();
			}
		},
	);
});
