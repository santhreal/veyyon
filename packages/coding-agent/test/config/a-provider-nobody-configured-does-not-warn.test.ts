/**
 * An unconfigured local-runtime provider whose loopback address refuses a connection must not warn.
 *
 * WHY THIS SUITE EXISTS. The registry logs discovery failures through `#warnProviderDiscoveryFailure`.
 * Historical analysis of production logs revealed 137 records of `model discovery failed for provider`,
 * of which 110 (80.3%) were `Unable to connect` against local runtimes nobody started on that host
 * (llama.cpp 74, lm-studio 21, ollama 15) plus 1 `HTTP 502`. The remaining 27 were actionable faults
 * (Anthropic 404, xAI OAuth 403, Devin aborted). Emitting a warning for unstarted local software buried
 * the actionable faults in noise.
 *
 * THE CLASS THIS CLOSES. Discovery failure severity distinction:
 * 1. An unconfigured provider (no stored credentials and no explicitly configured endpoint in models config)
 *    whose loopback endpoint refuses a TCP connection is an unstarted local runtime, recorded at `logger.debug`.
 * 2. A configured provider (stored credentials, explicitly configured base URL, or non-loopback endpoint)
 *    failing discovery is an actionable fault and is recorded at `logger.warn` with provider, url, and error.
 * 3. An unconfigured provider whose loopback endpoint answers with an HTTP error (e.g. 502/401) is a running
 *    server with a real fault and is recorded at `logger.warn`.
 * 4. An endpoint answering 200 with an empty catalog (`[]`) is not a failure and produces neither log.
 * 5. Deduplication on the exact error text is preserved across severity splits so transitions between reasons
 *    are recorded once per change.
 *
 * WHAT THIS DOES NOT CATCH. This does not catch bugs inside the model discovery parsers themselves, catalog
 * model construction, or transport stream failures during actual completions.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { IMPLICIT_LOCAL_RUNTIME_IDS, ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { logger, TempDir } from "@veyyon/utils";

interface LogRecord {
	message: string;
	provider?: string;
	url?: string;
	error?: string;
}

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@unconfigured-discovery-warn-");
});

afterEach(async () => {
	await tempDir.remove().catch(() => {});
});

/**
 * Harness driving real ModelRegistry discovery refresh while capturing logger.warn and logger.debug.
 */
async function driveDiscovery(options: {
	provider: string;
	modelsConfigYaml?: string;
	seedAuth?: (authStorage: AuthStorage) => Promise<void> | void;
	respond: (url: string) => Response | Promise<Response>;
}): Promise<{ warnings: LogRecord[]; debugs: LogRecord[]; registry: ModelRegistry }> {
	const warnings: LogRecord[] = [];
	const debugs: LogRecord[] = [];

	const warnSpy = spyOn(logger, "warn").mockImplementation((message: string, meta?: unknown) => {
		const fields = (meta ?? {}) as { provider?: string; url?: string; error?: string };
		warnings.push({ message, provider: fields.provider, url: fields.url, error: fields.error });
	});

	const debugSpy = spyOn(logger, "debug").mockImplementation((message: string, meta?: unknown) => {
		const fields = (meta ?? {}) as { provider?: string; url?: string; error?: string };
		debugs.push({ message, provider: fields.provider, url: fields.url, error: fields.error });
	});

	const modelsPath = path.join(tempDir.path(), "models.yml");
	if (options.modelsConfigYaml) {
		await Bun.write(modelsPath, options.modelsConfigYaml);
	} else {
		// Empty config: only implicit providers exist
		await Bun.write(modelsPath, "providers: {}\n");
	}

	const authDbPath = path.join(tempDir.path(), `auth-${Math.random().toString(36).slice(2)}.db`);
	const authStorage = await AuthStorage.create(authDbPath);
	if (options.seedAuth) {
		await options.seedAuth(authStorage);
	}

	const registry = new ModelRegistry(authStorage, modelsPath, {
		fetch: Object.assign(
			async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				return options.respond(url);
			},
			{ preconnect() {} },
		) as never,
	});

	try {
		await registry.refreshProvider(options.provider, "online");
	} finally {
		authStorage.close();
		warnSpy.mockRestore();
		debugSpy.mockRestore();
	}

	return {
		warnings: warnings.filter(w => w.provider === options.provider),
		debugs: debugs.filter(d => d.provider === options.provider),
		registry,
	};
}

describe("an unconfigured local provider", () => {
	it("logs connection refusal at debug and emits zero warnings", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "ollama",
			respond: () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			},
		});

		expect(warnings).toHaveLength(0);
		expect(debugs).toHaveLength(1);
		expect(debugs[0]?.message).toBe("model discovery failed for provider");
		expect(debugs[0]?.provider).toBe("ollama");
		expect(debugs[0]?.error).toContain("Unable to connect");
		expect(debugs[0]?.url).toBeDefined();
	});

	it("logs ECONNREFUSED at debug and emits zero warnings", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "llama.cpp",
			respond: () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
			},
		});

		expect(warnings).toHaveLength(0);
		expect(debugs).toHaveLength(1);
		expect(debugs[0]?.error).toContain("ECONNREFUSED");
	});

	it("still warns when an unconfigured loopback endpoint returns HTTP 502 Bad Gateway", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "llama.cpp",
			respond: () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.provider).toBe("llama.cpp");
		expect(warnings[0]?.error).toContain("502");
	});

	it("still warns when an unconfigured loopback endpoint returns HTTP 401", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "ollama",
			respond: () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.error).toContain("401");
	});

	it("warns on connection failure when an unconfigured provider has a default remote endpoint", async () => {
		// zenmux has allowUnauthenticated: true and default remote endpoint https://zenmux.ai/api/v1
		const { warnings, debugs } = await driveDiscovery({
			provider: "zenmux",
			respond: () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			},
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.provider).toBe("zenmux");
		expect(warnings[0]?.url).toContain("https://zenmux.ai");
	});

	it("still warns when an unconfigured loopback endpoint returns a malformed non-JSON payload", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "ollama",
			respond: () => new Response("<html>not json</html>", { status: 200 }),
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.error).toBeDefined();
	});

	it("emits neither warn nor debug when an unconfigured endpoint returns an empty model list", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "ollama",
			respond: () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(0);
	});
});

describe("a configured provider", () => {
	it("warns on connection refusal when baseUrl is explicitly configured in models.yml", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "ollama",
			modelsConfigYaml: ["providers:", "  ollama:", "    baseUrl: http://127.0.0.1:11434", ""].join("\n"),
			respond: () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			},
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.provider).toBe("ollama");
		expect(warnings[0]?.error).toContain("Unable to connect");
		expect(warnings[0]?.url).toContain("http://127.0.0.1:11434");
	});

	it("warns on connection refusal when a stored API key is present", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "llama.cpp",
			seedAuth: authStorage => {
				authStorage.setRuntimeApiKey("llama.cpp", "custom-key");
			},
			respond: () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
			},
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.provider).toBe("llama.cpp");
		expect(warnings[0]?.error).toContain("ECONNREFUSED");
	});

	it("warns when targeting a remote non-loopback endpoint", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "custom-remote",
			modelsConfigYaml: [
				"providers:",
				"  custom-remote:",
				"    baseUrl: https://api.example.com/v1",
				"    api: openai-completions",
				"    auth: none",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
			respond: () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			},
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.provider).toBe("custom-remote");
		expect(warnings[0]?.url).toContain("https://api.example.com/v1");
	});

	it("warns when targeting a LAN non-loopback host (e.g. 192.168.x)", async () => {
		const { warnings, debugs } = await driveDiscovery({
			provider: "lan-llama",
			modelsConfigYaml: [
				"providers:",
				"  lan-llama:",
				"    baseUrl: http://192.168.1.100:8080",
				"    api: openai-responses",
				"    auth: none",
				"    discovery:",
				"      type: llama.cpp",
				"",
			].join("\n"),
			respond: () => {
				throw new Error("connect EHOSTUNREACH 192.168.1.100:8080");
			},
		});

		expect(debugs).toHaveLength(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.provider).toBe("lan-llama");
		expect(warnings[0]?.url).toContain("http://192.168.1.100:8080");
	});
});

describe("deduplication and severity flipping", () => {
	it("deduplicates identical failures and reports reason changes across severity split", async () => {
		const warnings: LogRecord[] = [];
		const debugs: LogRecord[] = [];

		const warnSpy = spyOn(logger, "warn").mockImplementation((message: string, meta?: unknown) => {
			const fields = (meta ?? {}) as { provider?: string; url?: string; error?: string };
			warnings.push({ message, provider: fields.provider, url: fields.url, error: fields.error });
		});

		const debugSpy = spyOn(logger, "debug").mockImplementation((message: string, meta?: unknown) => {
			const fields = (meta ?? {}) as { provider?: string; url?: string; error?: string };
			debugs.push({ message, provider: fields.provider, url: fields.url, error: fields.error });
		});

		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(modelsPath, "providers: {}\n");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));

		let responseMode: "conn-refused" | "http-502" = "conn-refused";

		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: Object.assign(
				async () => {
					if (responseMode === "conn-refused") {
						throw new TypeError("Unable to connect. Is the computer able to access the url?");
					}
					return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
				},
				{ preconnect() {} },
			) as never,
		});

		try {
			// 1. First refresh: connection refused on unconfigured loopback -> 1 debug, 0 warn
			await registry.refreshProvider("ollama", "online");
			expect(debugs).toHaveLength(1);
			expect(warnings).toHaveLength(0);

			// 2. Second refresh: same connection refused -> deduped, no additional logs
			await registry.refreshProvider("ollama", "online");
			expect(debugs).toHaveLength(1);
			expect(warnings).toHaveLength(0);

			// 3. Third refresh: reason flips to HTTP 502 -> 1 warn emitted!
			responseMode = "http-502";
			await registry.refreshProvider("ollama", "online");
			expect(debugs).toHaveLength(1);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.error).toContain("502");

			// 4. Fourth refresh: same HTTP 502 -> deduped
			await registry.refreshProvider("ollama", "online");
			expect(debugs).toHaveLength(1);
			expect(warnings).toHaveLength(1);

			// 5. Fifth refresh: flips back to connection refused -> 1 more debug emitted
			responseMode = "conn-refused";
			await registry.refreshProvider("ollama", "online");
			expect(debugs).toHaveLength(2);
			expect(warnings).toHaveLength(1);
		} finally {
			authStorage.close();
			warnSpy.mockRestore();
			debugSpy.mockRestore();
		}
	});
});

describe("run-time variant space sweep", () => {
	const FAILURE_VARIANTS = [
		{
			kind: "connection-refused-typeerror",
			isConnectionRefusal: true,
			respond: () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			},
		},
		{
			kind: "connection-refused-econnrefused",
			isConnectionRefusal: true,
			respond: () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
			},
		},
		{
			kind: "status-401",
			isConnectionRefusal: false,
			respond: () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
		},
		{
			kind: "status-404",
			isConnectionRefusal: false,
			respond: () => new Response("not found", { status: 404, statusText: "Not Found" }),
		},
		{
			kind: "status-502",
			isConnectionRefusal: false,
			respond: () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
		},
		{
			kind: "malformed-html",
			isConnectionRefusal: false,
			respond: () => new Response("<html>nginx error</html>", { status: 200 }),
		},
		{
			kind: "malformed-json-syntax",
			isConnectionRefusal: false,
			respond: () => new Response('{"broken": json syntax', { status: 200 }),
		},
	] as const;

	const HOST_VARIANTS = [
		{ url: "http://127.0.0.1:8080", isLoopback: true },
		{ url: "http://localhost:11434", isLoopback: true },
		{ url: "http://[::1]:1234", isLoopback: true },
		{ url: "http://0.0.0.0:8000", isLoopback: true },
		{ url: "http://192.168.1.50:8080", isLoopback: false },
		{ url: "http://gpu-box.local:8080", isLoopback: false },
		{ url: "https://api.anthropic.com/v1", isLoopback: false },
	] as const;

	// Pin the exact set of failure shapes to ensure new failure modes require an explicit decision
	it("enumerates all failure variants with exact structural decisions", () => {
		const recordedKinds = FAILURE_VARIANTS.map(v => v.kind);
		expect(recordedKinds).toEqual([
			"connection-refused-typeerror",
			"connection-refused-econnrefused",
			"status-401",
			"status-404",
			"status-502",
			"malformed-html",
			"malformed-json-syntax",
		]);
	});

	for (const failure of FAILURE_VARIANTS) {
		for (const host of HOST_VARIANTS) {
			it(`correctly classifies ${failure.kind} against ${host.url} (loopback=${host.isLoopback})`, async () => {
				const confResult = await driveDiscovery({
					provider: "custom-test",
					modelsConfigYaml: [
						"providers:",
						"  custom-test:",
						`    baseUrl: ${host.url}`,
						"    api: openai-completions",
						"    auth: none",
						"    discovery:",
						"      type: openai-models-list",
						"",
					].join("\n"),
					respond: failure.respond,
				});

				// When explicitly configured in models.yml with baseUrl, it is CONFIGURED -> always warns
				expect(confResult.warnings.length).toBe(1);
				expect(confResult.debugs.length).toBe(0);
			});
		}
	}

	for (const failure of FAILURE_VARIANTS) {
		it(`classifies unconfigured implicit loopback failure for ${failure.kind}`, async () => {
			const result = await driveDiscovery({
				provider: "ollama",
				respond: failure.respond,
			});

			if (failure.isConnectionRefusal) {
				expect(result.warnings).toHaveLength(0);
				expect(result.debugs).toHaveLength(1);
				expect(result.debugs[0]?.provider).toBe("ollama");
			} else {
				expect(result.warnings).toHaveLength(1);
				expect(result.debugs).toHaveLength(0);
				expect(result.warnings[0]?.provider).toBe("ollama");
			}
		});
	}

	/**
	 * The providers the product probes without being asked are a table in source, and every
	 * row of it has to be exercised: a fourth local runtime added tomorrow inherits the
	 * loopback-refusal treatment, and a hardcoded list of three here would not notice.
	 */
	it("records exactly the local runtimes the product probes on its own", () => {
		expect([...IMPLICIT_LOCAL_RUNTIME_IDS]).toEqual(["ollama", "llama.cpp", "lm-studio"]);
	});

	for (const provider of IMPLICIT_LOCAL_RUNTIME_IDS) {
		it(`keeps a refused ${provider} probe out of the warnings`, async () => {
			const { warnings, debugs } = await driveDiscovery({
				provider,
				respond: () => {
					throw new TypeError("Unable to connect. Is the computer able to access the url?");
				},
			});

			expect(warnings).toHaveLength(0);
			expect(debugs).toHaveLength(1);
			expect(debugs[0]?.provider).toBe(provider);
		});

		it(`reports a ${provider} endpoint that answers badly`, async () => {
			const { warnings, debugs } = await driveDiscovery({
				provider,
				respond: () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
			});

			// Something is listening on that port and is broken, which is the operator's to fix.
			expect(debugs).toHaveLength(0);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.provider).toBe(provider);
		});
	}
});
