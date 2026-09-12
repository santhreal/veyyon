import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@veyyon/ai";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { BraveProvider } from "@veyyon/coding-agent/tools/web/search/providers/brave";
import { DuckDuckGoProvider } from "@veyyon/coding-agent/tools/web/search/providers/duckduckgo";
import {
	classifyProviderHttpError,
	handleProviderHttpError,
	resolveProviderKey,
	toSearchSources,
} from "@veyyon/coding-agent/tools/web/search/providers/utils";
import { SearchProviderError } from "@veyyon/coding-agent/tools/web/search/types";

/**
 * classifyProviderHttpError maps a provider's raw HTTP failure into a compact,
 * provider-tagged quota/auth error so the search orchestrator can chain-advance and
 * the final summary stays legible. Its precedence is deliberate and untested: the
 * credit/quota BODY pattern is checked BEFORE the status code, so a 401 whose body
 * says "quota" is reported as credits-exhausted, not unauthorized. toSearchSources
 * clamps a provider's source list to the requested count and annotates each with an
 * age. These pin the precedence table, the null pass-through for unknown failures,
 * and the clamp/annotate behavior.
 *
 * The body-signal tests also lock a widened CREDIT_BODY_PATTERN: the original only
 * matched "credits" immediately followed by exhausted/exceeded, so real provider
 * phrasings ("credits are exhausted", "you have exhausted your credits", "credit
 * limit exceeded", "out of credits") fell through to raw HTTP text. The boundary
 * cases below ("5 credits left", "rate limit exceeded", "credits: 42 remaining")
 * guard against the widening over-matching benign bodies.
 */

describe("classifyProviderHttpError — body signals", () => {
	it("classifies a credits-exhausted body regardless of status, including spaced phrasings", () => {
		const err = classifyProviderHttpError("brave", 200, "your credits are exhausted");
		expect(err).toBeInstanceOf(SearchProviderError);
		expect(err?.message).toBe("brave: credits exhausted");
		expect(err?.status).toBe(200);
		expect(err?.provider).toBe("brave");
		// Reversed order and words between credit(s) and the exhaustion verb also match.
		expect(classifyProviderHttpError("brave", 200, "you have exhausted your credits")?.message).toBe(
			"brave: credits exhausted",
		);
		expect(classifyProviderHttpError("brave", 200, "credit limit exceeded")?.message).toBe(
			"brave: credits exhausted",
		);
		expect(classifyProviderHttpError("brave", 200, "out of credits")?.message).toBe("brave: credits exhausted");
	});

	it("matches quota and insufficient bodies", () => {
		expect(classifyProviderHttpError("exa", 500, "monthly quota reached")?.message).toBe("exa: credits exhausted");
		expect(classifyProviderHttpError("exa", 500, "insufficient balance")?.message).toBe("exa: credits exhausted");
		expect(classifyProviderHttpError("exa", 500, "credit exceeded")?.message).toBe("exa: credits exhausted");
	});

	it("takes the body signal over the status code (401 with a quota body reads as credits)", () => {
		const err = classifyProviderHttpError("tavily", 401, "quota exceeded for this key");
		expect(err?.message).toBe("tavily: credits exhausted");
		expect(err?.status).toBe(401);
	});

	it("does not over-match a benign body that merely mentions credits or a rate limit", () => {
		// Boundary guards for the widened pattern: a remaining-credits count and a
		// rate-limit message must NOT read as credit exhaustion.
		expect(classifyProviderHttpError("jina", 200, "you have 5 credits left")).toBeNull();
		expect(classifyProviderHttpError("jina", 200, "credits: 42 remaining")).toBeNull();
		expect(classifyProviderHttpError("jina", 500, "rate limit exceeded")).toBeNull();
	});
});

describe("classifyProviderHttpError — status signals", () => {
	it("maps 402/401/403 to their tagged messages", () => {
		expect(classifyProviderHttpError("brave", 402, "Payment Required")?.message).toBe("brave: 402 credits exhausted");
		expect(classifyProviderHttpError("brave", 401, "Unauthorized")?.message).toBe("brave: 401 unauthorized");
		expect(classifyProviderHttpError("brave", 403, "Forbidden")?.message).toBe("brave: 403 forbidden");
	});

	it("returns null for a status/body that matches no known signal", () => {
		expect(classifyProviderHttpError("brave", 500, "internal server error")).toBeNull();
		expect(classifyProviderHttpError("brave", 200, "ok")).toBeNull();
	});
});

describe("toSearchSources", () => {
	const sources = [
		{ title: "A", url: "https://a", snippet: "sa" },
		{ title: "B", url: "https://b" },
		{ title: "C", url: "https://c", snippet: "sc" },
	];

	it("clamps the list to the requested result count", () => {
		const out = toSearchSources(sources, 2);
		expect(out.map(s => s.title)).toEqual(["A", "B"]);
	});

	it("returns every source when the count exceeds the list length", () => {
		expect(toSearchSources(sources, 10)).toHaveLength(3);
	});

	it("returns an empty list for a zero count", () => {
		expect(toSearchSources(sources, 0)).toEqual([]);
	});

	it("passes fields through and leaves ageSeconds undefined without a published date", () => {
		const [a] = toSearchSources([{ title: "A", url: "https://a", snippet: "sa" }], 1);
		expect(a).toEqual({
			title: "A",
			url: "https://a",
			snippet: "sa",
			publishedDate: undefined,
			ageSeconds: undefined,
		});
	});

	it("annotates a positive age for a past published date", () => {
		const [a] = toSearchSources([{ title: "A", url: "https://a", publishedDate: "2000-01-01" }], 1);
		expect(a.ageSeconds).toBeGreaterThan(0);
		expect(a.publishedDate).toBe("2000-01-01");
	});
});

describe("handleProviderHttpError", () => {
	it("throws classified error when body indicates credit exhaustion", async () => {
		const response = new Response("insufficient credits", { status: 500 });
		await expect(
			handleProviderHttpError("firecrawl", response, "Firecrawl API request failed (500)."),
		).rejects.toMatchObject({
			provider: "firecrawl",
			status: 500,
			message: "firecrawl: credits exhausted",
		});
	});

	it("throws fallback SearchProviderError with supplied message on unclassified error", async () => {
		const response = new Response("bad request", { status: 400 });
		await expect(
			handleProviderHttpError("firecrawl", response, "Firecrawl API request failed (400)."),
		).rejects.toMatchObject({
			provider: "firecrawl",
			status: 400,
			message: "Firecrawl API request failed (400).",
		});
	});
});

describe("resolveProviderKey", () => {
	it("resolves and invokes the exact stored credential with session selection", async () => {
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.set("brave", [
				{ type: "api_key", key: "key-default" },
				{ type: "api_key", key: "key-session-a" },
			]);
			const credentials = authStorage.listStoredCredentials("brave");
			expect(credentials).toHaveLength(2);
			authStorage.pinSessionCredential("brave", "sess-a", credentials[1]!.id);

			const resolveContext = { lastChance: false, error: undefined };
			const resolverDefault = resolveProviderKey(authStorage, "brave");
			const keyDefault =
				typeof resolverDefault === "function" ? await resolverDefault(resolveContext) : resolverDefault;
			expect(keyDefault).toBe("key-default");

			const resolverSession = resolveProviderKey(authStorage, "brave", "sess-a");
			const keySession =
				typeof resolverSession === "function" ? await resolverSession(resolveContext) : resolverSession;
			expect(keySession).toBe("key-session-a");
		} finally {
			store.close();
		}
	});

	it("falls back to environment variable or undefined when AuthStorage is undefined", () => {
		const origKey = process.env.BRAVE_API_KEY;
		try {
			process.env.BRAVE_API_KEY = "env-brave-key";
			expect(resolveProviderKey(undefined, "brave")).toBe("env-brave-key");

			delete process.env.BRAVE_API_KEY;
			expect(resolveProviderKey(undefined, "brave")).toBeUndefined();
		} finally {
			if (origKey === undefined) delete process.env.BRAVE_API_KEY;
			else process.env.BRAVE_API_KEY = origKey;
		}
	});
});

describe("real search provider availability contracts", () => {
	it("DuckDuckGoProvider is available without credentials", () => {
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		const authStorage = new AuthStorage(store);
		try {
			const provider = new DuckDuckGoProvider();
			expect(provider.isAvailable(authStorage)).toBe(true);
			expect(provider.isExplicitlyAvailable(authStorage)).toBe(true);
		} finally {
			store.close();
		}
	});

	it("BraveProvider respects absent, stored, and environment credentials", async () => {
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		const authStorage = new AuthStorage(store);
		const origKey = process.env.BRAVE_API_KEY;
		try {
			delete process.env.BRAVE_API_KEY;
			const provider = new BraveProvider();

			// 1. Absent credentials
			expect(provider.isAvailable(authStorage)).toBe(false);
			expect(provider.isExplicitlyAvailable(authStorage)).toBe(false);

			// 2. Stored credential in AuthStorage
			await authStorage.set("brave", { type: "api_key", key: "stored-brave-key" });
			expect(provider.isAvailable(authStorage)).toBe(true);
			expect(provider.isExplicitlyAvailable(authStorage)).toBe(true);

			// 3. Environment variable without stored credential
			const emptyDb = new Database(":memory:");
			const emptyStore = new SqliteAuthCredentialStore(emptyDb);
			const emptyStorage = new AuthStorage(emptyStore);
			try {
				process.env.BRAVE_API_KEY = "env-brave-key";
				expect(provider.isAvailable(emptyStorage)).toBe(true);
				expect(provider.isExplicitlyAvailable(emptyStorage)).toBe(true);
			} finally {
				emptyStore.close();
			}
		} finally {
			if (origKey === undefined) delete process.env.BRAVE_API_KEY;
			else process.env.BRAVE_API_KEY = origKey;
			store.close();
		}
	});
});
