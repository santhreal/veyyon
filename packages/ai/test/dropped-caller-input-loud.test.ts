import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { __resetDroppedEnforcedHeaderReportsForTests, buildAnthropicHeaders } from "@veyyon/ai/providers/anthropic";
import { logger } from "@veyyon/utils";

/**
 * Input the caller deliberately supplied and did not get is never a debug line.
 *
 * Two paths in this package take something the operator configured on purpose
 * and throw it away, because the branch has to own that value. Both are correct
 * to drop it and both used to record the drop at debug level, which makes the
 * outcome indistinguishable from the option having worked: the request
 * succeeds, and the configured header simply never arrives at the proxy.
 *
 * The person hunting that is looking at a working request. They have no reason
 * to suspect a drop happened at all, so nothing will lead them to turn debug
 * logging on and look for one. That is the whole reason Law 10 treats
 * `logger.debug` and carry on as silent.
 *
 * The report is bounded to once per distinct set, because both drops come from
 * configuration and would otherwise repeat, identically, on every request for
 * the life of the process.
 */
describe("Caller-supplied values that get dropped are announced, not logged at debug", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let debugs: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		debugs = [];
		__resetDroppedEnforcedHeaderReportsForTests();
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			debugs.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		__resetDroppedEnforcedHeaderReportsForTests();
	});

	const dropWarnings = () => warnings.filter(entry => entry.message.includes("replaced by this request's own values"));

	/** An OAuth request, the branch that must own `Authorization` itself. */
	const oauthHeaders = (modelHeaders: Record<string, string>) =>
		buildAnthropicHeaders({ apiKey: "sk-ant-oat01-token", isOAuth: true, modelHeaders });

	/**
	 * The core case. An OAuth request has to send its own bearer token, so a
	 * caller-supplied `Authorization` is dropped, and a proxy expecting that
	 * header sees a request that never carries it.
	 */
	test("warns, naming the header, when an OAuth request drops a caller Authorization", () => {
		const headers = oauthHeaders({ Authorization: "Bearer proxy-token" });

		// The drop itself is correct and unchanged: our own token is what goes out.
		expect(headers.Authorization).toBe("Bearer sk-ant-oat01-token");
		const reported = dropWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("not being sent");
		expect(reported[0]?.fields.headers).toEqual(["Authorization"]);
	});

	/**
	 * The values are the credentials being dropped, so they must never reach a
	 * log. This is the assertion that keeps a future "make the warning more
	 * useful" change from leaking a proxy token into a log file.
	 */
	test("logs the header names and never their values", () => {
		oauthHeaders({ Authorization: "Bearer super-secret-proxy-token" });

		const serialised = JSON.stringify(dropWarnings());
		expect(serialised).toContain("Authorization");
		expect(serialised).not.toContain("super-secret-proxy-token");
	});

	/**
	 * The bound. The headers come from configuration, so an unbounded warning
	 * fires on every request for the life of the process and buries itself.
	 */
	test("warns once per header set, then keeps recording at debug", () => {
		for (let i = 0; i < 4; i++) oauthHeaders({ Authorization: "Bearer proxy-token" });

		expect(dropWarnings()).toHaveLength(1);
		const quiet = debugs.filter(entry => entry.message.includes("still ignoring caller-supplied enforced headers"));
		expect(quiet).toHaveLength(3);
	});

	/**
	 * A different set of headers is a different fault and gets its own warning.
	 * Keying the bound on "has warned before" rather than on the set would mean
	 * the second misconfiguration is never announced at all.
	 */
	test("warns again for a different set of dropped headers", () => {
		buildAnthropicHeaders({
			apiKey: "sk-ant-oat01-token",
			isOAuth: true,
			isCloudflareAiGateway: true,
			modelHeaders: { Authorization: "Bearer proxy-token", "X-Api-Key": "sk-caller" },
		});
		oauthHeaders({ Authorization: "Bearer proxy-token" });

		const reported = dropWarnings();
		expect(reported).toHaveLength(2);
		expect(reported[0]?.fields.headers).toEqual(["Authorization", "X-Api-Key"]);
		expect(reported[1]?.fields.headers).toEqual(["Authorization"]);
	});

	/**
	 * An API-key request honours the caller's Authorization, so nothing is
	 * dropped and nothing may be said. Without this the suite would pass against
	 * an implementation that warned on every request that supplied headers at
	 * all, which is the ordinary proxy setup.
	 */
	test("says nothing when the caller's Authorization is honoured", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-key",
			isOAuth: false,
			modelHeaders: { Authorization: "Bearer proxy-token" },
		});

		expect(headers.Authorization).toBe("Bearer proxy-token");
		expect(dropWarnings()).toHaveLength(0);
	});

	/**
	 * On a non-OAuth request the caller's User-Agent is sent as given, so nothing
	 * was dropped and nothing may be said. A warning that names a header which
	 * WAS sent sends the reader chasing a fault that does not exist.
	 */
	test("says nothing about a User-Agent that is sent as given", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-key",
			isOAuth: false,
			modelHeaders: { "User-Agent": "my-proxy/1.0" },
		});

		expect(headers["User-Agent"]).toBe("my-proxy/1.0");
		expect(dropWarnings()).toHaveLength(0);
	});

	/**
	 * The OAuth branch is the exception, and it was the quietest drop of the lot:
	 * the User-Agent is part of the OAuth fingerprint, so a caller's UA is
	 * replaced outright. That replacement was not even collected as a drop, so it
	 * had no debug line either. A proxy that routes on User-Agent silently stops
	 * matching, on OAuth requests only.
	 */
	test("warns when an OAuth request replaces the caller's User-Agent", () => {
		const headers = oauthHeaders({ "User-Agent": "my-proxy/1.0" });

		expect(headers["User-Agent"]).toStartWith("claude-cli/");
		const reported = dropWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.headers).toEqual(["User-Agent"]);
	});

	/**
	 * A Claude Code User-Agent survives the OAuth branch untouched, so it is not
	 * a drop. Without this the fix above would warn on the ordinary OAuth path,
	 * which is every request this tool makes.
	 */
	test("says nothing when an OAuth request keeps a Claude Code User-Agent", () => {
		const ua = "claude-cli/2.0.0 (external, cli)";
		const headers = oauthHeaders({ "User-Agent": ua });

		expect(headers["User-Agent"]).toBe(ua);
		expect(dropWarnings()).toHaveLength(0);
	});

	/** A request with no caller headers at all is completely quiet. */
	test("says nothing when the caller supplied no headers", () => {
		buildAnthropicHeaders({ apiKey: "sk-ant-oat01-token", isOAuth: true });

		expect(dropWarnings()).toHaveLength(0);
	});
});
