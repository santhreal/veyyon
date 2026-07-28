import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ApiKey, Context, Model, SimpleStreamOptions } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { startMemoryStartupTask } from "@veyyon/coding-agent/memories";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { Snowflake, TempDir } from "@veyyon/utils";

interface MemoryBoundaryFixture {
	agentDir: string;
	sessionDir: string;
	settings: Settings;
	session: {
		sessionId: string;
		sessionManager: {
			getSessionFile: () => string;
			getSessionDir: () => string;
			getSessionId: () => string;
			getCwd: () => string;
		};
		settings: Settings;
		model: Model;
		modelRegistry: MemoryModelRegistry;
		obfuscator?: SecretObfuscator;
		obfuscateProviderText: (text: string) => string;
		refreshBaseSystemPrompt: () => Promise<void>;
	};
	modelRegistry: MemoryModelRegistry;
	whenSettled: Promise<void>;
}

interface MemoryModelRegistry {
	find: () => Model;
	getAll: () => Model[];
	getApiKey: () => Promise<string>;
	resolver: () => ApiKey;
}

let sharedRoot: TempDir | undefined;
let savedXdgData: string | undefined;
let savedXdgState: string | undefined;

beforeAll(async () => {
	sharedRoot = await TempDir.create(`@memories-provider-boundary-${Snowflake.next()}`);
	savedXdgData = process.env.XDG_DATA_HOME;
	savedXdgState = process.env.XDG_STATE_HOME;
	process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
	process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	process.env.XDG_DATA_HOME = savedXdgData;
	process.env.XDG_STATE_HOME = savedXdgState;
	if (sharedRoot) await sharedRoot.remove();
});

async function createFixture(overrides: Record<string, unknown> = {}): Promise<MemoryBoundaryFixture> {
	if (!sharedRoot) throw new Error("Memory boundary test root was not initialized");
	const agentDir = path.join(sharedRoot.path(), `agent-${Snowflake.next()}`);
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "current-session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);
	const settings = Settings.isolated({
		"memories.enabled": true,
		"memories.minRolloutIdleHours": 0,
		"memories.maxRolloutsPerStartup": 16,
		"memories.threadScanLimit": 64,
		"memories.stage1Concurrency": 1,
		"memories.phase2HeartbeatSeconds": 1,
		...overrides,
	});
	const model = {
		provider: "openai",
		id: "memory-boundary-model",
		name: "memory-boundary-model",
		contextWindow: 32_000,
	} as Model;
	const modelRegistry: MemoryModelRegistry = {
		find: () => model,
		getAll: () => [model],
		getApiKey: async () => "test-api-key",
		resolver: () => async () => "test-api-key",
	};
	let resolveSettled!: () => void;
	const whenSettled = new Promise<void>(resolve => {
		resolveSettled = resolve;
	});
	const session: MemoryBoundaryFixture["session"] = {
		sessionId: "memory-boundary-session",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionDir: () => sessionDir,
			getSessionId: () => "current-thread",
			getCwd: () => agentDir,
		},
		settings,
		model,
		modelRegistry,
		obfuscateProviderText: (text: string) => session.obfuscator?.obfuscate(text) ?? text,
		refreshBaseSystemPrompt: async () => resolveSettled(),
	};
	return { agentDir, sessionDir, settings, session, modelRegistry, whenSettled };
}

async function writeRollout(fixture: MemoryBoundaryFixture, id: string, messages: unknown[]): Promise<void> {
	const rows = [
		{ type: "session", id, cwd: fixture.agentDir },
		...messages.map(message => ({ type: "message", message })),
	];
	await fs.writeFile(
		path.join(fixture.sessionDir, `${id}.jsonl`),
		`${rows.map(row => JSON.stringify(row)).join("\n")}\n`,
	);
}

async function settle(fixture: MemoryBoundaryFixture): Promise<void> {
	await fixture.whenSettled;
}

function isStageOne(context: Context): boolean {
	return context.systemPrompt?.some(text => text.includes("memory-stage-one")) === true;
}

function successfulStageOne(label: string) {
	return {
		stopReason: "stop" as const,
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					rollout_summary: `Summary ${label}`,
					rollout_slug: label,
					raw_memory: `Memory ${label}`,
				}),
			},
		],
	};
}

const successfulPhaseTwo = {
	stopReason: "stop" as const,
	content: [
		{
			type: "text" as const,
			text: JSON.stringify({ memory_md: "# Memory\n\nConsolidated", memory_summary: "Consolidated", skills: [] }),
		},
	],
};

async function resolveApiKey(apiKey: ApiKey | undefined, error?: unknown): Promise<void> {
	if (typeof apiKey !== "function") return;
	await apiKey({ lastChance: false, error });
}

function start(fixture: MemoryBoundaryFixture): void {
	startMemoryStartupTask({
		session: fixture.session as never,
		settings: fixture.settings,
		modelRegistry: fixture.modelRegistry as never,
		agentDir: fixture.agentDir,
		taskDepth: 0,
	});
}

describe("memory provider boundary", () => {
	test("sanitizes allowlisted raw text while retaining ordinary text", async () => {
		// Why: persisted text is useful memory input, but it must be transformed before JSON can escape it.
		const fixture = await createFixture();
		const secret = "MEMORY_VISIBLE_SECRET_43d1";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		fixture.session.obfuscator = obfuscator;
		await writeRollout(fixture, "visible-text", [
			{ role: "user", content: [{ type: "text", text: `ordinary context and ${secret}` }] },
		]);
		let stageOnePayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				await resolveApiKey(options?.apiKey);
				if (isStageOne(context)) {
					stageOnePayload = JSON.stringify(context);
					return successfulStageOne("visible-text") as never;
				}
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(stageOnePayload).toContain("ordinary context");
		expect(stageOnePayload).toContain(obfuscator.obfuscate(secret));
		expect(stageOnePayload).not.toContain(secret);
	});

	test("leaves safe projected text unchanged when there is no runtime sanitizer", async () => {
		// Why: confidentiality hardening must not alter the existing local-memory semantics for safe text.
		const fixture = await createFixture();
		await writeRollout(fixture, "safe-text", [
			{ role: "assistant", content: [{ type: "text", text: "safe answer" }] },
		]);
		let stageOnePayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				await resolveApiKey(options?.apiKey);
				if (isStageOne(context)) {
					stageOnePayload = JSON.stringify(context);
					return successfulStageOne("safe-text") as never;
				}
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(stageOnePayload).toContain("safe answer");
		expect(stageOnePayload).toContain('\\"role\\":\\"assistant\\",\\"text\\":\\"safe answer\\"');
	});

	test("obfuscates complete secrets before head-tail token truncation can expose fragments", async () => {
		// Why: an exact-match sanitizer cannot recognize a prefix after truncation has already split the secret.
		const fixture = await createFixture({ "memories.phase1InputTokenLimit": 12 });
		const secret = "MEMORY_BOUNDARY_SECRET_ABCDEF";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		fixture.session.obfuscator = obfuscator;
		await writeRollout(fixture, "truncation-boundary", [{ role: "user", content: secret.repeat(12) }]);
		let stageOnePayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				await resolveApiKey(options?.apiKey);
				if (isStageOne(context)) {
					stageOnePayload = JSON.stringify(context);
					return successfulStageOne("truncation-boundary") as never;
				}
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(stageOnePayload).not.toContain(secret);
		expect(stageOnePayload).not.toContain("MEMORY_BOUNDARY");
		expect(stageOnePayload).not.toContain("SECRET_ABCDEF");
	});

	test("sanitizes a full allowlisted tool result before applying its size cap", async () => {
		// Why: the 32k tool-result cap is another lossy boundary. Dropping/projecting first would
		// prevent the current short placeholder from reaching stage one and can split a future
		// chunked implementation's exact marker before the sanitizer sees it.
		const fixture = await createFixture();
		const secret = `MEMORY_TOOL_CHUNK_START_${"T".repeat(33_000)}_MEMORY_TOOL_CHUNK_END`;
		await writeRollout(fixture, "tool-chunk-boundary", [
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: secret }] },
		]);
		fixture.modelRegistry.resolver = () => async () => {
			fixture.session.obfuscator = new SecretObfuscator([
				{ type: "plain", content: secret, name: "TOOL_CHUNK_CURRENT" },
			]);
			return "test-key";
		};
		let stageOnePayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				await resolveApiKey(options?.apiKey);
				if (isStageOne(context)) {
					stageOnePayload = JSON.stringify(context);
					return successfulStageOne("tool-chunk-boundary") as never;
				}
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(stageOnePayload).toContain("#TOOL_CHUNK_CURRENT#");
		expect(stageOnePayload).not.toContain(secret);
		expect(stageOnePayload).not.toContain("MEMORY_TOOL_CHUNK_START");
		expect(stageOnePayload).not.toContain("MEMORY_TOOL_CHUNK_END");
	});

	test("projects adversarial messages onto text only and omits image, binary, replay, and nested payloads", async () => {
		// Why: string obfuscation cannot inspect a secret after arbitrary bytes have been base64-encoded.
		const fixture = await createFixture();
		const visibleSecret = "MEMORY_TEXT_SECRET_a814";
		const hiddenBinary = "MEMORY_BINARY_SECRET_290614";
		const nestedSecret = "MEMORY_NESTED_SECRET_712";
		const secretKey = "MEMORY_SECRET_KEY_551";
		const encodedBinary = Buffer.from(hiddenBinary).toString("base64");
		const obfuscator = new SecretObfuscator([{ type: "plain", content: visibleSecret }]);
		fixture.session.obfuscator = obfuscator;
		await writeRollout(fixture, "adversarial", [
			{
				role: "user",
				content: [
					{ type: "text", text: `retain this ${visibleSecret}`, [secretKey]: nestedSecret },
					{ type: "image", data: encodedBinary, mimeType: `image/png;${nestedSecret}` },
					{ type: "opaque", payload: { [secretKey]: nestedSecret } },
				],
				providerPayload: { items: [{ [secretKey]: nestedSecret, data: encodedBinary }] },
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "assistant text" },
					{ type: "toolCall", name: "bash", arguments: { [secretKey]: nestedSecret, data: encodedBinary } },
				],
			},
		]);
		let stageOnePayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				await resolveApiKey(options?.apiKey);
				if (isStageOne(context)) {
					stageOnePayload = JSON.stringify(context);
					return successfulStageOne("adversarial") as never;
				}
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(stageOnePayload).toContain("retain this");
		expect(stageOnePayload).toContain("assistant text");
		for (const forbidden of [
			visibleSecret,
			hiddenBinary,
			encodedBinary,
			nestedSecret,
			secretKey,
			"providerPayload",
			"toolCall",
			"mimeType",
		]) {
			expect(stageOnePayload).not.toContain(forbidden);
		}
	});

	test("dereferences the owning session separately for each claimed rollout", async () => {
		// Why: a callback closed over the first obfuscator and leaked secrets introduced by a later runtime refresh.
		const fixture = await createFixture({ "memories.stage1Concurrency": 2 });
		const firstSecret = "MEMORY_FIRST_RUNTIME_SECRET_131";
		const secondSecret = "MEMORY_SECOND_RUNTIME_SECRET_242";
		fixture.session.obfuscator = new SecretObfuscator([{ type: "plain", content: firstSecret }]);
		await writeRollout(fixture, "claim-a", [{ role: "user", content: firstSecret }]);
		await writeRollout(fixture, "claim-b", [{ role: "user", content: secondSecret }]);
		const stageOnePayloads: string[] = [];
		let stageOneInvocations = 0;
		let releaseFirstSanitization!: () => void;
		const firstSanitization = new Promise<void>(resolve => {
			releaseFirstSanitization = resolve;
		});
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				if (isStageOne(context)) {
					stageOneInvocations += 1;
					const invocation = stageOneInvocations;
					if (invocation > 1) await firstSanitization;
					await resolveApiKey(options?.apiKey);
					stageOnePayloads.push(JSON.stringify(context));
					if (invocation === 1) {
						fixture.session.obfuscator = new SecretObfuscator([{ type: "plain", content: secondSecret }]);
						releaseFirstSanitization();
					}
					return successfulStageOne(`claim-${invocation}`) as never;
				}
				await resolveApiKey(options?.apiKey);
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(stageOnePayloads).toHaveLength(2);
		expect(stageOnePayloads[0]).not.toContain(firstSecret);
		expect(stageOnePayloads[1]).not.toContain(secondSecret);
	});

	test("uses the sanitizer installed while phase two is reading raw memories", async () => {
		// Why: phase two performs awaited file reads, so a pre-read runtime snapshot is stale at dispatch.
		const fixture = await createFixture();
		const phaseTwoSecret = "MEMORY_PHASE_TWO_READ_SECRET_819";
		await writeRollout(fixture, "phase-two-read", [{ role: "user", content: "seed" }]);
		const originalFile = Bun.file.bind(Bun);
		let swapped = false;
		vi.spyOn(Bun, "file").mockImplementation((input, options) => {
			const file =
				typeof input === "number"
					? originalFile(input, options)
					: typeof input === "string" || input instanceof URL
						? originalFile(input, options)
						: originalFile(input, options);
			if (swapped || typeof input !== "string" || !input.endsWith("raw_memories.md")) return file;
			return new Proxy(file, {
				get(target, property, receiver) {
					if (property !== "text") return Reflect.get(target, property, receiver);
					return async () => {
						const text = await target.text();
						fixture.session.obfuscator = new SecretObfuscator([{ type: "plain", content: phaseTwoSecret }]);
						swapped = true;
						return text;
					};
				},
			});
		});
		let phaseTwoPayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				await resolveApiKey(options?.apiKey);
				if (isStageOne(context)) {
					return {
						...successfulStageOne("phase-two-read"),
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									rollout_summary: "Summary",
									rollout_slug: "phase-two-read",
									raw_memory: phaseTwoSecret,
								}),
							},
						],
					} as never;
				}
				phaseTwoPayload = JSON.stringify(context);
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(swapped).toBe(true);
		expect(phaseTwoPayload).not.toContain(phaseTwoSecret);
		const obfuscatedPhaseTwoSecret = fixture.session.obfuscator?.obfuscate(phaseTwoSecret);
		if (obfuscatedPhaseTwoSecret === undefined) throw new Error("runtime obfuscator was not installed");
		expect(phaseTwoPayload).toContain(obfuscatedPhaseTwoSecret);
	});

	test("rebuilds a truncated stage-one request with the runtime selected for each credential attempt", async () => {
		// Why: if JSON projection/truncation runs before an awaited credential refresh, a marker
		// crossing the head-tail cut becomes two fragments that an exact sanitizer cannot match.
		const fixture = await createFixture({ "memories.phase1InputTokenLimit": 24 });
		const lateSecret = `MEMORY_RETRY_RUNTIME_BOUNDARY_START_${"Q".repeat(120)}_BOUNDARY_END`;
		await writeRollout(fixture, "retry-refresh", [
			{ role: "user", content: `prefix-${lateSecret}-tail-${"z".repeat(160)}` },
		]);
		let underlyingResolutions = 0;
		fixture.modelRegistry.resolver = () => async () => {
			underlyingResolutions += 1;
			const name = underlyingResolutions === 1 ? "FIRST_ATTEMPT" : "CURRENT_ATTEMPT";
			fixture.session.obfuscator = new SecretObfuscator([{ type: "plain", content: lateSecret, name }]);
			return `test-key-${underlyingResolutions}`;
		};
		const attempts: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				if (isStageOne(context)) {
					await resolveApiKey(options?.apiKey);
					attempts.push(JSON.stringify(context));
					await resolveApiKey(options?.apiKey, new Error("401"));
					attempts.push(JSON.stringify(context));
					return successfulStageOne("retry-refresh") as never;
				}
				await resolveApiKey(options?.apiKey);
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(attempts).toHaveLength(2);
		for (const attempt of attempts) {
			expect(attempt).not.toContain(lateSecret);
			expect(attempt).not.toContain("MEMORY_RETRY_RUNTIME_BOUNDARY");
			expect(attempt).not.toContain("BOUNDARY_END");
		}
		expect(attempts[0]).toContain("#FIRST_ATTEMPT#");
		expect(attempts[1]).toContain("#CURRENT_ATTEMPT#");
	});

	test("sanitizes phase-two source strings before truncation after credential resolution", async () => {
		// Why: phase two has its own 80k-character head-tail projection. This raw marker is long
		// enough to straddle that cut, while its current placeholder makes the sanitized source
		// fit without truncation; only sanitize-before-project can preserve the whole placeholder.
		const fixture = await createFixture();
		const phaseTwoSecret = `PHASE_TWO_BOUNDARY_START_${"R".repeat(10_000)}_PHASE_TWO_BOUNDARY_END`;
		const phaseTwoMemory = `${"a".repeat(43_000)}${phaseTwoSecret}${"b".repeat(25_000)}`;
		await writeRollout(fixture, "phase-two-credential-boundary", [{ role: "user", content: "seed" }]);
		let resolvingPhaseTwo = false;
		fixture.modelRegistry.resolver = () => async () => {
			if (resolvingPhaseTwo) {
				fixture.session.obfuscator = new SecretObfuscator([
					{ type: "plain", content: phaseTwoSecret, name: "PHASE_TWO_CURRENT" },
				]);
			}
			return "test-key";
		};
		let phaseTwoPayload = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model: Model, context: Context, options?: SimpleStreamOptions) => {
				if (isStageOne(context)) {
					await resolveApiKey(options?.apiKey);
					return {
						...successfulStageOne("phase-two-credential-boundary"),
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									rollout_summary: "Summary",
									rollout_slug: "phase-two-credential-boundary",
									raw_memory: phaseTwoMemory,
								}),
							},
						],
					} as never;
				}
				resolvingPhaseTwo = true;
				await resolveApiKey(options?.apiKey);
				phaseTwoPayload = JSON.stringify(context);
				return successfulPhaseTwo as never;
			},
		);

		start(fixture);
		await settle(fixture);
		expect(phaseTwoPayload).toContain("#PHASE_TWO_CURRENT#");
		expect(phaseTwoPayload).not.toContain(phaseTwoSecret);
		expect(phaseTwoPayload).not.toContain("PHASE_TWO_BOUNDARY_START");
		expect(phaseTwoPayload).not.toContain("PHASE_TWO_BOUNDARY_END");
	});
});
