import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
} from "@veyyon/ai";
import { type BenchModelRegistry, runBenchCommand } from "@veyyon/coding-agent/cli/bench-cli";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { benchPrompts } from "@veyyon/coding-agent/prompts/bench/rows";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		maxTokens: 4096,
		contextWindow: 128_000,
	} as unknown as Model<Api>;
}

function fakeStream(after?: () => Promise<void>): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		usage: { input: 5, output: 1 },
		duration: 10,
		ttft: 1,
	} as unknown as AssistantMessage;
	const iterator = (async function* () {
		await after?.();
		yield { type: "text_delta", delta: "ok" } as unknown as AssistantMessageEvent;
		yield { type: "done", message } as unknown as AssistantMessageEvent;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function registry(models: Model<Api>[], authenticated = true): BenchModelRegistry {
	return {
		getAll: () => models,
		hasConfiguredAuth: () => authenticated,
		getApiKey: async () => (authenticated ? "sk-test" : undefined),
		resolver: () => (() => Promise.resolve(authenticated ? "sk-test" : undefined)) as unknown as ApiKeyResolver,
	};
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-bench-confidentiality-"));
	roots.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "profile", "agent");
	await fs.mkdir(path.join(cwd, ".veyyon"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	const settings = {
		get: () => undefined,
		getCwd: () => cwd,
		getAgentDir: () => agentDir,
	} as unknown as Settings;
	return { cwd, agentDir, settings };
}

function promptText(context: Context): string {
	const message = context.messages[0];
	if (message?.role !== "user" || typeof message.content !== "string") throw new Error("expected text prompt");
	return message.content;
}

describe("bench custom prompt provider confidentiality", () => {
	it("reloads and sanitizes profile and project declarations for every provider and run", async () => {
		// Why: a benchmark fans one operator string out to N providers × M runs; sanitizing
		// only the first target or sharing a prepared raw context multiplies the disclosure.
		const { cwd, agentDir, settings } = await fixture();
		const profileSecret = "BENCH_PROFILE_SECRET_741852";
		const projectSecret = "BENCH_PROJECT_SECRET_963258";
		await fs.writeFile(
			path.join(agentDir, "secrets.yml"),
			`- type: plain\n  content: ${JSON.stringify(profileSecret)}\n  mode: replace\n  replacement: "[PROFILE]"\n`,
		);
		await fs.writeFile(
			path.join(cwd, ".veyyon", "secrets.yml"),
			`- type: plain\n  content: ${JSON.stringify(projectSecret)}\n  mode: replace\n  replacement: "[PROJECT]"\n`,
		);
		const models = [fakeModel("provider-a", "model-a"), fakeModel("provider-b", "model-b")];
		const captures: Array<{ provider: string; prompt: string }> = [];

		const summary = await runBenchCommand(
			{
				models: ["provider-a/model-a", "provider-b/model-b"],
				flags: { runs: 2, par: 2, maxTokens: 32, json: true, prompt: `${profileSecret} / ${projectSecret}` },
			},
			{
				createRuntime: async () => ({
					modelRegistry: registry(models),
					settings,
					globalConfigRoot: path.join(agentDir, "..", "..", "global"),
				}),
				randomSessionId: () => crypto.randomUUID(),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (model, context) => {
					captures.push({ provider: model.provider, prompt: promptText(context) });
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(summary.failures).toBe(0);
		expect(captures).toHaveLength(4);
		expect(captures.map(capture => capture.provider).sort()).toEqual([
			"provider-a",
			"provider-a",
			"provider-b",
			"provider-b",
		]);
		for (const capture of captures) {
			expect(capture.prompt).toBe("[PROFILE] / [PROJECT]");
			expect(capture.prompt).not.toContain(profileSecret);
			expect(capture.prompt).not.toContain(projectSecret);
		}
	});

	it("transforms the raw custom prompt before trimming boundary bytes", async () => {
		// Why: trimming first can remove a byte that belongs to the configured secret,
		// preventing an exact match while leaving the rest reconstructable on the wire.
		const { cwd, agentDir, settings } = await fixture();
		const boundarySecret = "  BENCH_BOUNDARY_SECRET_159357";
		await fs.writeFile(
			path.join(cwd, ".veyyon", "secrets.yml"),
			`- type: plain\n  content: ${JSON.stringify(boundarySecret)}\n  mode: replace\n  replacement: "[BOUNDARY]"\n`,
		);
		const model = fakeModel("provider-a", "model-a");
		let captured = "";

		await runBenchCommand(
			{ models: ["provider-a/model-a"], flags: { runs: 1, prompt: `${boundarySecret} tail` } },
			{
				createRuntime: async () => ({
					modelRegistry: registry([model]),
					settings,
					globalConfigRoot: path.join(agentDir, "..", "..", "global"),
				}),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context) => {
					captured = promptText(context);
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(captured).toBe("[BOUNDARY] tail");
		expect(captured).not.toContain("BENCH_BOUNDARY_SECRET_159357");
	});

	it("uses the current declaration set on a later run instead of a stale snapshot", async () => {
		// Why: credentials and files can refresh while a long benchmark is running; each
		// repeated physical dispatch must resolve the runtime that is current at that send.
		const { cwd, agentDir, settings } = await fixture();
		const oldSecret = "BENCH_OLD_RUNTIME_SECRET_111333";
		const newSecret = "BENCH_NEW_RUNTIME_SECRET_222444";
		const secretsPath = path.join(cwd, ".veyyon", "secrets.yml");
		const declaration = (secret: string) =>
			`- type: plain\n  content: ${JSON.stringify(secret)}\n  mode: replace\n  replacement: "[CURRENT]"\n`;
		await fs.writeFile(secretsPath, declaration(oldSecret));
		const model = fakeModel("provider-a", "model-a");
		const captures: string[] = [];

		await runBenchCommand(
			{
				models: ["provider-a/model-a"],
				flags: { runs: 2, par: 1, prompt: `${oldSecret} ${newSecret}` },
			},
			{
				createRuntime: async () => ({
					modelRegistry: registry([model]),
					settings,
					globalConfigRoot: path.join(agentDir, "..", "..", "global"),
				}),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context) => {
					captures.push(promptText(context));
					return fakeStream(captures.length === 1 ? () => fs.writeFile(secretsPath, declaration(newSecret)) : undefined);
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(captures).toEqual([`[CURRENT] ${newSecret}`, `${oldSecret} [CURRENT]`]);
	});

	it("loads and protects live detected environment values", async () => {
		// Why: standalone CLI paths do not inherit AgentSession initialization, so a
		// secrets.yml-only loader silently misses sensitive environment values.
		const { cwd, agentDir, settings } = await fixture();
		const globalConfigRoot = path.join(agentDir, "..", "..", "global");
		const envName = "VEYYON_BENCH_RUNTIME_TOKEN";
		const secret = "BENCH_ENV_RUNTIME_SECRET_864209";
		const previous = process.env[envName];
		process.env[envName] = secret;
		const model = fakeModel("provider-a", "model-a");
		let captured = "";

		try {
			await runBenchCommand(
				{ models: ["provider-a/model-a"], flags: { runs: 1, prompt: `environment ${secret}` } },
				{
					createRuntime: async () => ({
						modelRegistry: registry([model]),
						settings,
						globalConfigRoot,
					}),
					writeStdout: () => {},
					writeStderr: () => {},
					setExitCode: () => {},
					streamSimple: (_model, context) => {
						captured = promptText(context);
						return fakeStream();
					},
					now: () => 0,
					stdoutIsTTY: false,
				},
			);
		} finally {
			if (previous === undefined) delete process.env[envName];
			else process.env[envName] = previous;
		}

		expect(captured).toStartWith("environment ");
		expect(captured).not.toContain(secret);
	});

	it("loads the applicable encrypted vault and uses its persisted placeholder key", async () => {
		// Why: named vault entries are encrypted and absent from secrets.yml. Loading
		// their value without the persisted key would either fail or mint placeholders
		// that cannot participate in the same profile's reversible secret workflow.
		const { cwd, agentDir, settings } = await fixture();
		const globalConfigRoot = path.join(agentDir, "..", "..", "global");
		const secret = "BENCH_VAULT_RUNTIME_SECRET_975310";
		const vault = new SecretVault(resolveVaultLocations({ globalConfigRoot, agentDir, cwd }));
		await vault.add({ name: "BENCH_VAULT", value: secret, scope: "profile", ttl: null });
		const model = fakeModel("provider-a", "model-a");
		let captured = "";

		const summary = await runBenchCommand(
			{ models: ["provider-a/model-a"], flags: { runs: 1, prompt: `vault ${secret}` } },
			{
				createRuntime: async () => ({
					modelRegistry: registry([model]),
					settings,
					globalConfigRoot,
				}),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context) => {
					captured = promptText(context);
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(summary.failures).toBe(0);
		expect(captured).toBe("vault #BENCH_VAULT#");
		expect(captured).not.toContain(secret);
	});

	it("fails closed on malformed declarations without echoing their bytes", async () => {
		// Why: YAML parser diagnostics may include the offending source line, which can
		// itself contain the secret. The provider and the user-visible failure get neither.
		const { cwd, agentDir, settings } = await fixture();
		const secret = "BENCH_MALFORMED_SECRET_456789";
		await fs.writeFile(path.join(cwd, ".veyyon", "secrets.yml"), `- type: plain\n  content: ${secret}\n  broken: [\n`);
		const model = fakeModel("provider-a", "model-a");
		let dispatches = 0;

		const summary = await runBenchCommand(
			{ models: ["provider-a/model-a"], flags: { runs: 1, prompt: `send ${secret}` } },
			{
				createRuntime: async () => ({
					modelRegistry: registry([model]),
					settings,
					globalConfigRoot: path.join(agentDir, "..", "..", "global"),
				}),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: () => {
					dispatches++;
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(dispatches).toBe(0);
		expect(summary.failures).toBe(1);
		const result = summary.models[0].results[0];
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected bench failure");
		expect(result.error).toContain("Refusing to send custom benchmark prompt");
		expect(result.error).not.toContain(secret);
	});

	it("does not load custom-prompt declarations for the fixed built-in benchmark", async () => {
		// Why: the fixed prompt contains no operator bytes and must retain its prior
		// credential and dispatch behavior even when an unrelated declaration is broken.
		const { cwd, agentDir, settings } = await fixture();
		await fs.writeFile(path.join(cwd, ".veyyon", "secrets.yml"), "not: [valid");
		const model = fakeModel("provider-a", "model-a");
		let captured = "";

		const summary = await runBenchCommand(
			{ models: ["provider-a/model-a"], flags: { runs: 1 } },
			{
				createRuntime: async () => ({
					modelRegistry: registry([model]),
					settings,
					globalConfigRoot: path.join(agentDir, "..", "..", "global"),
				}),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, context) => {
					captured = promptText(context);
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(summary.failures).toBe(0);
		expect(captured).toBe(benchPrompts["bench/throughput"].text.trim());
	});

	it("reports missing credentials without loading or echoing a custom secret prompt", async () => {
		// Why: credential preflight must remain credential-first. With no possible send,
		// parsing operator data is unnecessary and the standard auth diagnostic must not
		// accidentally interpolate the custom prompt.
		const { cwd, agentDir, settings } = await fixture();
		const secret = "BENCH_NO_CREDENTIAL_SECRET_753951";
		await fs.writeFile(path.join(cwd, ".veyyon", "secrets.yml"), `- type: plain\n  content: ${secret}\n  broken: [\n`);
		const model = fakeModel("provider-a", "model-a");
		let dispatches = 0;

		const summary = await runBenchCommand(
			{ models: ["provider-a/model-a"], flags: { runs: 1, prompt: secret } },
			{
				createRuntime: async () => ({
					modelRegistry: registry([model], false),
					settings,
					globalConfigRoot: path.join(agentDir, "..", "..", "global"),
				}),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: () => {
					dispatches++;
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);

		expect(dispatches).toBe(0);
		expect(summary.failures).toBe(1);
		const result = summary.models[0].results[0];
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected bench failure");
		expect(result.error).toContain("No credentials for provider");
		expect(result.error).not.toContain(secret);
	});
});
