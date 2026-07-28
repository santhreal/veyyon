import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentSession } from "../session/agent-session";
import { HindsightApi } from "./client";
import type { HindsightConfig } from "./config";
import { HindsightSessionState } from "./state";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

interface CapturedRequest {
	url: string;
	init?: FetchInit;
}

function captureFetch(responses: Response[] = []): CapturedRequest[] {
	const captures: CapturedRequest[] = [];
	const fetchStub = Object.assign(
		async (input: FetchInput, init?: FetchInit) => {
			captures.push({ url: String(input), init });
			return responses.shift() ?? Response.json({ results: [] });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	return captures;
}

function parsedBody(capture: CapturedRequest): unknown {
	return JSON.parse(String(capture.init?.body));
}

function replaceAll(text: string, secret: string, replacement = "[redacted]"): string {
	return text.split(secret).join(replacement);
}

describe("Hindsight outbound confidentiality boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sanitizes retain content, context, metadata keys and values, tags, ids, and path segments while preserving auth", async () => {
		const secret = "HINDSIGHT_RETAIN_SECRET";
		const captures = captureFetch();
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			apiKey: `auth-${secret}`,
			obfuscateProviderText: text => replaceAll(text, secret),
		});

		await client.retain(`bank-${secret}`, `content-${secret}`, {
			context: `context-${secret}`,
			metadata: { [`metadata-${secret}`]: `value-${secret}` },
			documentId: `document-${secret}`,
			tags: [`tag-${secret}`],
			async: true,
		});

		expect(captures).toHaveLength(1);
		expect(captures[0].url).toContain("bank-%5Bredacted%5D");
		expect(captures[0].init?.headers).toEqual({
			"User-Agent": "veyyon-coding-agent",
			"Content-Type": "application/json",
			Authorization: `Bearer auth-${secret}`,
		});
		expect(parsedBody(captures[0])).toEqual({
			items: [
				{
					content: "content-[redacted]",
					context: "context-[redacted]",
					metadata: { "metadata-[redacted]": "value-[redacted]" },
					document_id: "document-[redacted]",
					tags: ["tag-[redacted]"],
				},
			],
			async: true,
		});
	});

	it("sanitizes recall, reflect, and query-string keys and values at dispatch", async () => {
		const secret = "HINDSIGHT_QUERY_SECRET";
		const captures = captureFetch();
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			obfuscateProviderText: text => {
				if (text === "q") return "mapped_query";
				return replaceAll(text, secret);
			},
		});

		await client.recall("bank", `recall-${secret}`, { tags: [`recall-tag-${secret}`] });
		await client.reflect("bank", `reflect-${secret}`, {
			context: `reflect-context-${secret}`,
			tags: [`reflect-tag-${secret}`],
		});
		await client.listMemories("bank", { q: `filter-${secret}`, type: `type-${secret}` });

		expect(parsedBody(captures[0])).toMatchObject({
			query: "recall-[redacted]",
			tags: ["recall-tag-[redacted]"],
		});
		expect(parsedBody(captures[1])).toMatchObject({
			query: "reflect-[redacted]",
			context: "reflect-context-[redacted]",
			tags: ["reflect-tag-[redacted]"],
		});
		const query = new URL(captures[2].url).searchParams;
		expect(query.get("mapped_query")).toBe("filter-[redacted]");
		expect(query.get("type")).toBe("type-[redacted]");
		expect(captures.map(capture => `${capture.url}\n${String(capture.init?.body)}`).join("\n")).not.toContain(secret);
	});

	it("sanitizes bank missions and mental-model names, ids, tags, and adversarial nested keys", async () => {
		const secret = "HINDSIGHT_MODEL_SECRET";
		const captures = captureFetch();
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			obfuscateProviderText: text => replaceAll(text, secret),
		});
		const trigger = {
			mode: "full" as const,
			[`nested-${secret}`]: `nested-value-${secret}`,
		};

		await client.createBank(`bank-${secret}`, {
			reflectMission: `reflect-mission-${secret}`,
			retainMission: `retain-mission-${secret}`,
		});
		await client.createMentalModel(`bank-${secret}`, `name-${secret}`, `source-${secret}`, {
			id: `model-${secret}`,
			tags: [`model-tag-${secret}`],
			trigger,
		});
		await client.getDocument(`bank-${secret}`, `document-${secret}`);

		expect(parsedBody(captures[0])).toEqual({
			reflect_mission: "reflect-mission-[redacted]",
			retain_mission: "retain-mission-[redacted]",
		});
		expect(parsedBody(captures[1])).toMatchObject({
			id: "model-[redacted]",
			name: "name-[redacted]",
			source_query: "source-[redacted]",
			tags: ["model-tag-[redacted]"],
			trigger: {
				mode: "full",
				"nested-[redacted]": "nested-value-[redacted]",
			},
		});
		expect(captures[2].url).toContain("bank-%5Bredacted%5D/documents/document-%5Bredacted%5D");
		expect(captures.map(capture => `${capture.url}\n${String(capture.init?.body)}`).join("\n")).not.toContain(secret);
	});

	it("rejects mapped-key collisions before fetch without putting either raw key in the error", async () => {
		const firstRawKey = "first-collision-secret";
		const secondRawKey = "second-collision-secret";
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			obfuscateProviderText: text => (text.endsWith("collision-secret") ? "mapped-key" : text),
		});
		const metadata = { [firstRawKey]: "one", [secondRawKey]: "two" };

		const error = await client.retain("bank", "content", { metadata }).then(
			() => null,
			(reason: unknown) => reason,
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toContain("confidentiality key collision");
		expect(message).not.toContain(firstRawKey);
		expect(message).not.toContain(secondRawKey);
	});

	it("fails closed with a generic error when a transform throws secret-bearing diagnostics", async () => {
		const secret = "HINDSIGHT_THROWN_SECRET";
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			obfuscateProviderText: text => {
				if (text.includes(secret)) throw new Error(`cannot transform ${text}`);
				return text;
			},
		});

		const error = await client.recall("bank", `query-${secret}`).then(
			() => null,
			(reason: unknown) => reason,
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toBe("Hindsight request confidentiality transform failed.");
		expect(message).not.toContain(secret);
	});

	it("leaves standalone local-style clients unchanged when no transform is registered", async () => {
		const captures = captureFetch();
		const client = new HindsightApi({ baseUrl: "http://127.0.0.1:9999", apiKey: "local-token" });

		await client.retain("local-bank", "literal-local-content", {
			context: "literal-local-context",
			tags: ["literal-local-tag"],
		});

		expect(captures[0].url).toContain("/local-bank/memories");
		expect(parsedBody(captures[0])).toMatchObject({
			items: [{ content: "literal-local-content", context: "literal-local-context", tags: ["literal-local-tag"] }],
		});
		expect(captures[0].init?.headers).toMatchObject({ Authorization: "Bearer local-token" });
	});

	it("re-resolves live transforms for caller retries instead of reusing a stale sanitized snapshot", async () => {
		const secret = "HINDSIGHT_RETRY_SECRET";
		const captures = captureFetch([Response.json({ detail: "retry" }, { status: 503 }), Response.json({})]);
		let replacement = "[attempt-one]";
		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			obfuscateProviderText: text => replaceAll(text, secret, replacement),
		});

		await expect(client.retain("bank", secret)).rejects.toThrow("retain failed");
		replacement = "[attempt-two]";
		await client.retain("bank", secret);

		expect(parsedBody(captures[0])).toMatchObject({ items: [{ content: "[attempt-one]" }] });
		expect(parsedBody(captures[1])).toMatchObject({ items: [{ content: "[attempt-two]" }] });
		expect(captures.map(capture => String(capture.init?.body)).join("\n")).not.toContain(secret);
	});
});

interface MutableObfuscator {
	obfuscate(text: string): string;
}

function createStateHarness(configOverrides: Partial<HindsightConfig> = {}) {
	const captures = captureFetch();
	const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
	let runtime: MutableObfuscator | undefined;
	let currentState: HindsightSessionState | undefined;
	const sessionStub = {
		get obfuscator() {
			return runtime;
		},
		// The live redaction authority the state actually calls. A getter over the same mutable
		// binding, not a snapshot, because every test here swaps the runtime mid-flight to prove the
		// transform resolves it at the moment of use rather than at construction.
		obfuscateProviderText: (text: string) => runtime?.obfuscate(text) ?? text,
		getHindsightSessionState: () => currentState,
		emitNotice: () => {},
		sessionManager: { getEntries: () => [] },
	};
	// The state touches only this deliberately narrow AgentSession surface in
	// these boundary tests; production supplies the full concrete class.
	const session = sessionStub as unknown as AgentSession;
	const config = {
		debug: false,
		retainContext: "coding-agent",
		retainMode: "full-session",
		retainEveryNTurns: 1,
		retainOverlapTurns: 0,
		recallBudget: "mid",
		recallMaxTokens: 1_000,
		recallTypes: [],
		recallContextTurns: 1,
		recallMaxQueryChars: 1_000,
		recallPromptPreamble: "Relevant memories:",
		autoRecall: true,
		mentalModelsEnabled: false,
		...configOverrides,
	} as HindsightConfig;
	const state = new HindsightSessionState({
		sessionId: "session",
		client,
		bankId: "bank",
		config,
		session,
		banksSet: new Set(["bank"]),
	});
	currentState = state;
	return {
		captures,
		state,
		setRuntime(next: MutableObfuscator | undefined) {
			runtime = next;
		},
	};
}

describe("Hindsight session delayed and lossy boundaries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps queued retain data raw until flush and uses the runtime active after the delay", async () => {
		const secret = "HINDSIGHT_DELAYED_SECRET";
		const harness = createStateHarness();
		harness.setRuntime({ obfuscate: text => text });
		harness.state.enqueueRetain(`queued-${secret}`, `queued-context-${secret}`);
		harness.setRuntime({ obfuscate: text => replaceAll(text, secret, "[current-runtime]") });

		await harness.state.flushRetainQueue();
		harness.state.dispose();

		expect(harness.captures).toHaveLength(1);
		expect(parsedBody(harness.captures[0])).toMatchObject({
			items: [{ content: "queued-[current-runtime]", context: "queued-context-[current-runtime]" }],
		});
		expect(String(harness.captures[0].init?.body)).not.toContain(secret);
	});

	it("resolves the current runtime after a delayed recall wait, not before it", async () => {
		const secret = "HINDSIGHT_DELAYED_RECALL_SECRET";
		const harness = createStateHarness({ mentalModelsEnabled: true });
		let release!: () => void;
		harness.state.mentalModelsLoadPromise = new Promise<void>(resolve => {
			release = resolve;
		});
		harness.setRuntime({ obfuscate: text => text });

		const pending = harness.state.beforeAgentStartPrompt(secret);
		harness.setRuntime({ obfuscate: text => replaceAll(text, secret, "[fresh-runtime]") });
		release();
		await pending;
		harness.state.dispose();

		expect(harness.captures).toHaveLength(1);
		expect(parsedBody(harness.captures[0])).toMatchObject({ query: "[fresh-runtime]" });
		expect(String(harness.captures[0].init?.body)).not.toContain(secret);
	});

	it("transforms raw recall fields before character truncation can expose a secret prefix", async () => {
		const secret = "HINDSIGHT_BOUNDARY_SECRET_ABCDEF";
		const harness = createStateHarness({ recallMaxQueryChars: 8 });
		harness.setRuntime({ obfuscate: text => replaceAll(text, secret, "[safe]") });

		await harness.state.recallForCompaction([{ role: "user", content: secret }]);
		harness.state.dispose();

		expect(harness.captures).toHaveLength(1);
		expect(parsedBody(harness.captures[0])).toMatchObject({ query: "[safe]" });
		expect(String(harness.captures[0].init?.body)).not.toContain(secret.slice(0, 8));
	});
});
