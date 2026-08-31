/**
 * A failing embedding provider must not look like a memory store with embeddings switched off.
 *
 * WHY THIS SUITE EXISTS. `embed` answers "no vectors" with `null`, and every caller responds to `null`
 * the same way: fall back to keyword-only search. That is also exactly what happens when embeddings are
 * disabled, so a provider that is throwing on every call produced a memory system whose semantic recall
 * had quietly stopped working, and whose results were merely "less relevant" with nothing to explain it.
 * Recall loss you cannot see is the worst kind, because nothing looks broken.
 *
 * The HTTP path already reported through `reportEmbeddingFailure`, described in its own doc as the one
 * place that reports a failed embedding request. The two PROVIDER paths did not: they caught and returned
 * `null` bare, so the same loss went unreported depending on which route was configured. They now use the
 * same owner, which is why this suite asserts the shared message and the fields the operator acts on
 * rather than whatever each path could have said for itself.
 *
 * `null` is still returned. Keyword-only search is a real fallback and a memory lookup must not fail
 * outright because a vector could not be produced, so the report is the entire fix.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "@veyyon/utils";
import { embed, resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from "../src/core/embeddings";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

let warnings: Warning[];
let restore: () => void;

beforeEach(() => {
	warnings = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	restore = () => spy.mockRestore();
});

afterEach(() => {
	resetEmbeddingProviderForTests();
	restore();
});

/** The single warning this suite is about, picked out of anything else the call may log. */
function embeddingReports(): Warning[] {
	return warnings.filter(warning => warning.message.includes("Memory embedding failed"));
}

describe("a provider that returns vectors", () => {
	/**
	 * The ordinary case: vectors come back and nothing is reported.
	 *
	 * A provider yields BATCHES of rows, not rows, and the collector turns each row into a `Float32Array`.
	 * Getting that wrong is quiet rather than loud (a batch of numbers is read as a batch of one-element
	 * rows and every vector comes out empty), so the shape is pinned here as part of the contract.
	 */
	it("produces the vectors and warns about nothing", async () => {
		setEmbeddingProviderForTests({
			// An async generator, because `EmbeddingOutput` is an `AsyncIterable` of batches. A plain array of
			// batches happens to work at runtime and does not typecheck, which is worth not papering over.
			embed: async function* () {
				yield [[0.5, 0.25]];
			},
		});

		expect(await embed(["remember this"])).toEqual([new Float32Array([0.5, 0.25])]);
		expect(embeddingReports()).toEqual([]);
	});
});

describe("a provider that throws", () => {
	/**
	 * The regression this exists to prevent. The caller still gets `null` so keyword-only search takes over,
	 * and the report is the only thing that distinguishes this from embeddings being turned off.
	 */
	it("returns null and reports the loss", async () => {
		setEmbeddingProviderForTests({
			embed: async () => {
				throw new Error("connection refused");
			},
		});

		expect(await embed(["remember this"])).toBeNull();
		expect(embeddingReports()).toHaveLength(1);
	});

	/**
	 * The message has to say what it costs the reader, because the symptom they will actually notice is
	 * "the memory results got worse". These three fields are the whole point of the shared reporter: the
	 * cause, the impact, and something to do about it.
	 */
	it("says semantic recall is unavailable and what to do", async () => {
		setEmbeddingProviderForTests({
			embed: async () => {
				throw new Error("connection refused");
			},
		});

		await embed(["remember this"]);

		const report = embeddingReports()[0];
		expect(report?.message).toContain("falling back to keyword-only search");
		expect(String(report?.meta.cause)).toContain("connection refused");
		expect(String(report?.meta.impact)).toContain("Semantic recall");
		expect(String(report?.meta.fix)).not.toBe("");
	});

	/**
	 * The report names WHICH route failed. A base URL is meaningless for a registered provider, so the
	 * shared reporter takes a target and the provider paths pass `provider:<name>`; without it an operator
	 * with both an HTTP endpoint and a provider configured cannot tell which one to look at.
	 */
	it("names the provider route rather than a base URL", async () => {
		setEmbeddingProviderForTests({
			embed: async () => {
				throw new Error("boom");
			},
		});

		await embed(["remember this"]);

		expect(String(embeddingReports()[0]?.meta.target)).toStartWith("provider:");
	});

	/**
	 * A provider that rejects rather than throwing synchronously is the same loss and must report too: the
	 * failure arrives through the awaited call either way, and a fix that only caught one shape would leave
	 * the common asynchronous case silent.
	 */
	it("reports an asynchronous rejection", async () => {
		setEmbeddingProviderForTests({ embed: () => Promise.reject(new Error("gateway timeout")) });

		expect(await embed(["remember this"])).toBeNull();
		expect(String(embeddingReports()[0]?.meta.cause)).toContain("gateway timeout");
	});
});

describe("calls that were never going to embed anything", () => {
	/**
	 * An empty input list is not a failure: there is nothing to embed, `null` is the honest answer, and a
	 * warning here would fire on ordinary use. This is the case the reporting must NOT be attached to,
	 * since it is the one that made the old silence look reasonable.
	 */
	it("returns null for no texts without reporting", async () => {
		setEmbeddingProviderForTests({
			embed: async () => {
				throw new Error("must not be called");
			},
		});

		expect(await embed([])).toBeNull();
		expect(embeddingReports()).toEqual([]);
	});
});
