/**
 * ensureBankExists caches bank ids in a process-wide Set so a long-lived
 * session does not PUT the same bank on every retain. The set is capped at
 * 10_000. On overflow it sorts the keys lexicographically and deletes the
 * first half — not insertion order, not "the oldest id in wall-clock time".
 *
 * That distinction is the defect waiting to happen: JS Set iteration is
 * insertion order, and the comment says "drop the oldest half". The code
 * does `[...banksSet].sort()` first. A bank whose id sorts late (z-…) can
 * survive forever while a newly created bank whose id sorts early (a-…) is
 * dropped on the next overflow, forcing a redundant PUT.
 *
 * Prefilling the set is one contract, not 10_000 cases. createBank is
 * mocked so this does not talk to a Hindsight server.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { ensureBankExists } from "@veyyon/coding-agent/hindsight/bank";
import { HindsightApi } from "@veyyon/coding-agent/hindsight/client";
import type { HindsightConfig } from "@veyyon/coding-agent/hindsight/config";

const CAP = 10_000;

const baseConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 120_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "veyyon",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

describe("ensureBankExists caps the in-process set by lexicographic half, not insertion order", () => {
	let client: HindsightApi;
	let createSpy: Mock<HindsightApi["createBank"]> | undefined;

	beforeEach(() => {
		client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
	});

	afterEach(() => {
		createSpy?.mockRestore();
	});

	it("does not PUT a bank whose id is already in the set, even at cap", async () => {
		const seen = new Set<string>(["already"]);
		await ensureBankExists(client, "already", baseConfig(), seen);
		expect(createSpy).not.toHaveBeenCalled();
		expect(seen.size).toBe(1);
	});

	it("drops the lexicographically-first half when the set grows past 10_000", async () => {
		const seen = new Set<string>();
		for (let i = 0; i < CAP; i++) {
			seen.add(`m-${String(i).padStart(5, "0")}`);
		}
		expect(seen.size).toBe(CAP);

		await ensureBankExists(client, "zzz-new", baseConfig({ bankMission: "x" }), seen);

		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledWith(
			"zzz-new",
			expect.objectContaining({ reflectMission: "x" }),
		);
		// 10000 + 1 then drop floor(10001/2) = 5000 → 5001 remain.
		expect(seen.size).toBe(5001);
		expect(seen.has("zzz-new")).toBe(true);
		// m-00000 is the lexicographic minimum of the prefilled ids; it must go.
		expect(seen.has("m-00000")).toBe(false);
		// m-09999 sorts after the cut; with zzz-new in the set it should survive.
		expect(seen.has("m-09999")).toBe(true);
	});

	it("a bank whose id sorts early is not protected by having been inserted last", async () => {
		const seen = new Set<string>();
		for (let i = 0; i < CAP; i++) {
			seen.add(`z-${String(i).padStart(5, "0")}`);
		}
		await ensureBankExists(client, "aaa-newest", baseConfig(), seen);
		// Insertion-order "oldest half" would have dropped z-00000..; lexicographic
		// sort drops aaa-newest together with the early z- keys that sort after it.
		// aaa-newest is the minimum key, so it is in the deleted half.
		expect(seen.has("aaa-newest")).toBe(false);
		expect(seen.has("z-09999")).toBe(true);
	});

	it("whitespace-only missions are forwarded as undefined, matching the blank-mission PUT", async () => {
		const seen = new Set<string>();
		await ensureBankExists(
			client,
			"bank",
			baseConfig({ bankMission: "\t  ", retainMission: "  " }),
			seen,
		);
		expect(createSpy).toHaveBeenCalledWith(
			"bank",
			expect.objectContaining({ reflectMission: undefined, retainMission: undefined }),
		);
	});

	it("a failed PUT does not add the id, so overflow cannot be triggered by failures", async () => {
		createSpy!.mockRejectedValueOnce(new Error("HTTP 503"));
		const seen = new Set<string>();
		for (let i = 0; i < CAP; i++) seen.add(`k-${i}`);
		await ensureBankExists(client, "new", baseConfig(), seen);
		expect(seen.size).toBe(CAP);
		expect(seen.has("new")).toBe(false);
	});
});
