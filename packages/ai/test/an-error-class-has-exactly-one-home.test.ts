/**
 * WHY: five error classes were declared twice — `AuthBrokerError` and
 * `AuthBrokerStreamUnsupportedError` in both `error/classes.ts` and
 * `auth-broker/client.ts`, and `CodexWebSocketTransportError`,
 * `CodexWhitespaceToolCallLoopError` and `CodexProviderStreamError` in both
 * `error/classes.ts` and `providers/openai-codex-responses.ts`. Two classes
 * with one name make `instanceof` answer false for an error that carries the
 * name, so `remote-store.ts` tested identity against a class its own thrower
 * never constructed, and `classify()` compared `error.name` to a string
 * literal — a check any object can pass by assigning a field.
 *
 * The class of defect: an error type with more than one constructor. This
 * suite fails when a name reachable from the package surface resolves to two
 * constructors, and when classification accepts a name instead of an identity.
 *
 * What it does not catch: a duplicate class that is private to its module and
 * never exported. That copy becomes visible the moment something needs to
 * classify it, which is the `name ===` compare this suite pins against.
 */
import { describe, expect, it } from "bun:test";
import * as AI from "@veyyon/ai";
import * as AuthBroker from "@veyyon/ai/auth-broker";
import * as AIError from "@veyyon/ai/error";

/** Every exported value that is an Error subclass, with the paths it is reachable through. */
function errorClasses(surfaces: Record<string, object>): Map<string, Map<unknown, string[]>> {
	const byName = new Map<string, Map<unknown, string[]>>();
	for (const [surface, namespace] of Object.entries(surfaces)) {
		for (const [exported, value] of Object.entries(namespace)) {
			if (typeof value !== "function") continue;
			if (!(value.prototype instanceof Error)) continue;
			const name = value.name;
			const homes = byName.get(name) ?? new Map<unknown, string[]>();
			const paths = homes.get(value) ?? [];
			paths.push(`${surface}#${exported}`);
			homes.set(value, paths);
			byName.set(name, homes);
		}
	}
	return byName;
}

describe("an error class has exactly one home", () => {
	const surfaces = { "@veyyon/ai": AI, "@veyyon/ai/error": AIError, "@veyyon/ai/auth-broker": AuthBroker };

	it("resolves every exported error name to a single constructor", () => {
		const collisions: string[] = [];
		for (const [name, homes] of errorClasses(surfaces)) {
			if (homes.size < 2) continue;
			collisions.push(`${name}: ${[...homes.values()].map(paths => paths.join("/")).join(" vs ")}`);
		}
		expect(collisions).toEqual([]);
	});

	it("reaches at least the classified error classes through the surface", () => {
		// Guards the sweep itself: an empty walk would pass the collision check
		// above while proving nothing.
		const names = new Set(errorClasses(surfaces).keys());
		for (const required of [
			"AuthBrokerError",
			"AuthBrokerStreamUnsupportedError",
			"CodexProviderStreamError",
			"CodexWebSocketTransportError",
			"ProviderHttpError",
		]) {
			expect(names.has(required)).toBe(true);
		}
	});

	it("throws the shared class from the auth-broker client", async () => {
		const client = new AuthBroker.AuthBrokerClient({
			url: "http://127.0.0.1:1",
			token: "t",
			maxRetries: 0,
			fetchImpl: (async () =>
				new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch,
		});
		const error = await client.healthz().then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(AIError.AuthBrokerError);
	});

	it("keeps the stream-unsupported sentinel a subclass of the broker error", () => {
		const sentinel = new AIError.AuthBrokerStreamUnsupportedError();
		expect(sentinel).toBeInstanceOf(AIError.AuthBrokerError);
		expect(sentinel.status).toBe(404);
	});

	it("classifies a Codex stream failure by identity, not by name", () => {
		const real = new AIError.CodexProviderStreamError("sprocket count mismatch", { retryable: true });
		expect(AIError.is(AIError.classify(real), AIError.Flag.Transient)).toBe(true);
		const impostor = Object.assign(new Error("sprocket count mismatch"), {
			name: "CodexProviderStreamError",
			retryable: true,
		});
		expect(AIError.is(AIError.classify(impostor), AIError.Flag.Transient)).toBe(false);
	});
});
