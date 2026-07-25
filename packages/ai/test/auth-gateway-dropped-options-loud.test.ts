import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AuthGatewayParsedRequest } from "@veyyon/ai/auth-gateway";
import { __resetDroppedTypedOptionReportsForTests, buildStreamOptions } from "@veyyon/ai/auth-gateway";
import { logger } from "@veyyon/utils";

/**
 * A request option the gateway cannot forward must not disappear at debug level.
 *
 * The gateway accepts the full OpenAI and Anthropic request shapes, but several
 * fields have no matching pi-ai `SimpleStreamOptions` slot, so they are dropped
 * on the way through. Dropping them is the correct behaviour: widening them
 * into `options.extra` would force every consumer to re-implement the typed
 * parse to read them back out. Recording that at debug level was not.
 *
 * The consequence is specific and nasty. A client that sets `response_format`
 * to a JSON schema and gets prose back, or sets `seed` and gets different
 * answers to byte-identical requests, is looking at a 200 with a well-formed
 * body. Nothing failed, so nothing points at the gateway, and the option that
 * was ignored is the one thing the client is sure it sent. That is Law 10's
 * exact shape: the mechanism was unavailable, something else happened instead,
 * and the operator was not told.
 *
 * The report is bounded to one warning per API and option set, because these
 * come from a client that sends the same request shape every time.
 */
describe("Request options the gateway cannot forward are announced, not logged at debug", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let debugs: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		debugs = [];
		__resetDroppedTypedOptionReportsForTests();
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			debugs.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		__resetDroppedTypedOptionReportsForTests();
	});

	const dropWarnings = () => warnings.filter(entry => entry.message.includes("cannot forward some request options"));

	/** A minimal parsed request carrying only the options under test. */
	function build(options: AuthGatewayParsedRequest["options"], api = "openai-completions"): void {
		const parsed: AuthGatewayParsedRequest = {
			modelId: "gpt-test",
			context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			stream: false,
			options,
		};
		buildStreamOptions(parsed, api as never, new AbortController().signal);
	}

	/**
	 * The core case, using the option whose loss is hardest to diagnose: a client
	 * that asked for a JSON schema and received free text has no reason at all to
	 * suspect the gateway.
	 */
	test("warns, naming the option, when response_format is dropped", () => {
		build({ responseFormat: { type: "json_object" } });

		const reported = dropWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("had no effect on this request");
		expect(reported[0]?.fields.dropped).toEqual(["responseFormat"]);
		expect(reported[0]?.fields.api).toBe("openai-completions");
	});

	/**
	 * Every dropped option is named, not just the first. A client sending three
	 * unsupported fields needs to know about all three, or it fixes one and keeps
	 * getting the same wrong answers.
	 */
	test("names every dropped option in one report", () => {
		build({ seed: 42, user: "alice", parallelToolCalls: false });

		const reported = dropWarnings();
		expect(reported).toHaveLength(1);
		expect([...((reported[0]?.fields.dropped ?? []) as string[])].sort()).toEqual([
			"parallelToolCalls",
			"seed",
			"user",
		]);
	});

	/**
	 * The values are caller data: `user` identifies an end user and `logitBias`
	 * describes their prompt. Only the names are ever logged, and this pins that
	 * so a later "make the warning more useful" change cannot leak them.
	 */
	test("logs the option names and never their values", () => {
		build({ user: "customer-4417-private", logitBias: { "1234": 100 } });

		const serialised = JSON.stringify(dropWarnings());
		expect(serialised).toContain("user");
		expect(serialised).toContain("logitBias");
		expect(serialised).not.toContain("customer-4417-private");
	});

	/**
	 * The bound. A client sends the same request shape on every call, so an
	 * unbounded warning would repeat forever and bury itself.
	 */
	test("warns once per api and option set, then keeps recording at debug", () => {
		for (let i = 0; i < 4; i++) build({ seed: i });

		expect(dropWarnings()).toHaveLength(1);
		const quiet = debugs.filter(entry => entry.message.includes("still dropping unsupported typed options"));
		expect(quiet).toHaveLength(3);
	});

	/**
	 * A different option set is a different fault. Keying the bound on "has
	 * warned before" would mean the second unsupported field is never announced.
	 */
	test("warns again for a different option set", () => {
		build({ seed: 1 });
		build({ responseFormat: { type: "json_object" } });

		expect(dropWarnings()).toHaveLength(2);
	});

	/**
	 * The same options under a different API are a separate report, because which
	 * API dropped them is what tells the operator where to look.
	 */
	test("warns separately for the same options under a different api", () => {
		build({ seed: 1 }, "openai-completions");
		build({ seed: 1 }, "anthropic-messages");

		const reported = dropWarnings();
		expect(reported).toHaveLength(2);
		expect(reported.map(entry => entry.fields.api)).toEqual(["openai-completions", "anthropic-messages"]);
	});

	/**
	 * Supported options must be silent. Without this the suite would pass against
	 * an implementation that warned on every request, which is the ordinary path
	 * and would make the warning worthless.
	 */
	test("says nothing when every option supplied is forwarded", () => {
		build({ temperature: 0.5, maxOutputTokens: 100, topP: 0.9 });

		expect(dropWarnings()).toHaveLength(0);
	});

	/** A request with no options at all is completely quiet. */
	test("says nothing when the request carries no options", () => {
		build({});

		expect(dropWarnings()).toHaveLength(0);
	});

	/**
	 * A `false` or `0` value is still a value the caller set on purpose, and it
	 * still gets dropped. A truthiness check instead of an `undefined` check
	 * would miss exactly the cases where the caller was disabling something.
	 */
	test("reports a dropped option whose value is falsy", () => {
		build({ parallelToolCalls: false, seed: 0 });

		const reported = dropWarnings();
		expect(reported).toHaveLength(1);
		expect([...((reported[0]?.fields.dropped ?? []) as string[])].sort()).toEqual(["parallelToolCalls", "seed"]);
	});
});
