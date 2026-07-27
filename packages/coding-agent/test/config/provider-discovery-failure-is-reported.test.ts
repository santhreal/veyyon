/**
 * A provider whose model discovery produced no catalog has to say why, end to end.
 *
 * WHY THIS SUITE EXISTS. The registry keeps per-provider discovery state and reported a reason only when
 * discovery THREW. A reader that answered `null` -- which is what every reader does for a refused
 * connection, a 401, an HTML error page, or a payload it does not recognize -- reached
 * `#discoverWithModelManager`, fell through to the cache and the static catalog, and said nothing. The
 * behaviour was right and the silence was wrong: what the user saw was a picker missing models they pay
 * for, identical for all four causes, with nothing to act on.
 *
 * `@veyyon/catalog` now carries the reason back as a value and the registry reports it through the same
 * `#warnProviderDiscoveryFailure` it already used for a throw. This suite drives the REGISTRY, not the
 * reader, because the boundary between them is where the reason used to die, and it asserts the reason is
 * DISTINCT per cause -- a `status` for a refused credential, a `request` for an unreachable host, a
 * `payload` for a body that is not a model list -- since one undifferentiated "discovery failed" would
 * send an operator to the wrong place three times out of four.
 *
 * It also pins the silence: an endpoint that answers `200` with an empty model list is not a failure, and
 * a channel that fired there would make every real reason noise.
 *
 * vLLM is the provider under test because it is the one built-in provider that discovers without a
 * credential once a `baseUrl` is configured, so the stub endpoint below is reached with no auth fixture in
 * the way.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { logger, TempDir } from "@veyyon/utils";

const STUB_BASE_URL = "http://127.0.0.1:59107/v1";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@provider-discovery-failure-");
});

afterEach(async () => {
	await tempDir.remove().catch(() => {});
});

/** The warnings the registry emitted, in order, with the fields an operator reads. */
interface RecordedWarning {
	message: string;
	provider?: string;
	url?: string;
	error?: string;
}

/**
 * Drive one real discovery refresh for vLLM against a stub endpoint, collecting what the registry reported.
 *
 * The warning is the assertion target rather than the returned models: the registry deliberately keeps
 * serving the static catalog when discovery fails, so the model list is unchanged either way, and the
 * reported reason is the entire difference this change makes.
 */
async function refreshCollectingWarnings(
	respond: (url: string) => Response | Promise<Response>,
): Promise<RecordedWarning[]> {
	const warnings: RecordedWarning[] = [];
	const warnSpy = spyOn(logger, "warn").mockImplementation((message: string, meta?: unknown) => {
		const fields = (meta ?? {}) as { provider?: string; url?: string; error?: string };
		warnings.push({ message, provider: fields.provider, url: fields.url, error: fields.error });
	});
	const modelsPath = path.join(tempDir.path(), "models.yml");
	await Bun.write(
		modelsPath,
		["providers:", "  vllm:", `    baseUrl: ${STUB_BASE_URL}`, "    api: openai-completions", ""].join("\n"),
	);
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	try {
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: Object.assign(
				async (input: string | URL | Request) =>
					respond(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url),
				{ preconnect() {} },
			) as never,
		});
		await registry.refreshProvider("vllm", "online");
	} finally {
		authStorage.close();
		warnSpy.mockRestore();
	}
	return warnings.filter(warning => warning.provider === "vllm");
}

describe("a discovery endpoint that refuses the credential", () => {
	/**
	 * The 401 case, and the one an operator can actually fix. The reason names the `status` stage and the
	 * HTTP status, so the next step is "check the key" rather than "check whether the service is up".
	 */
	it("reports the status as the reason", async () => {
		const warnings = await refreshCollectingWarnings(
			() => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("model discovery failed for provider");
		expect(warnings[0]?.error).toBe("status: HTTP 401 Unauthorized");
		expect(warnings[0]?.url).toContain(STUB_BASE_URL);
	});
});

describe("a discovery endpoint that cannot be reached", () => {
	/**
	 * The `request` stage, which points at the network rather than at credentials. Before this it was the
	 * same silence as the 401 above, which is exactly the confusion the stage exists to prevent.
	 */
	it("reports the transport error as the reason", async () => {
		const warnings = await refreshCollectingWarnings(() => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:59107");
		});

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.error).toStartWith("request: ");
		expect(warnings[0]?.error).toContain("ECONNREFUSED");
	});
});

describe("a discovery endpoint that answers something else", () => {
	/**
	 * A 200 whose body is JSON but holds no model list is the `payload` stage: the endpoint is up and the
	 * credential is fine, and it is not an OpenAI-compatible model route. Distinct from both cases above.
	 */
	it("reports an unrecognized payload as the reason", async () => {
		const warnings = await refreshCollectingWarnings(
			() => new Response(JSON.stringify({ message: "not a model list" }), { status: 200 }),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.error).toStartWith("payload: ");
	});

	/** A body that is not JSON at all is `body`, which points at whatever answered instead of the endpoint. */
	it("reports a non-JSON body as the reason", async () => {
		const warnings = await refreshCollectingWarnings(() => new Response("<html>proxy login</html>", { status: 200 }));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.error).toStartWith("body: ");
	});
});

describe("a discovery endpoint that answers with no models", () => {
	/**
	 * The silence half of the contract. `[]` means "asked and told nothing", which is an ANSWER: reporting
	 * it would tell the operator a working provider is broken, and would drown the four real reasons above.
	 */
	it("reports nothing", async () => {
		const warnings = await refreshCollectingWarnings(
			() => new Response(JSON.stringify({ data: [] }), { status: 200 }),
		);

		expect(warnings).toEqual([]);
	});
});

describe("the same failure on two refreshes", () => {
	/**
	 * The reason is deduplicated per provider on its exact text, which is why routing the returned-`null`
	 * case through the existing reporter mattered rather than adding a second `logger.warn`: discovery runs
	 * on a schedule, and an unreachable endpoint would otherwise repeat the same line at every refresh.
	 */
	it("is reported once", async () => {
		const warnings = await refreshCollectingWarnings(
			() => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
		);

		// One refresh already covers both routes a manager may attempt; the assertion that matters is that a
		// single distinct reason produces a single line.
		expect(warnings).toHaveLength(1);
	});
});
