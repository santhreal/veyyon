/**
 * WHY: `sanitizeArtifacts` rebuilt the artifacts from an enumerated list of five fields on the
 * way into the journal. `usage` was not on that list, so the token counts and the dollar amount a
 * backend measured were dropped at the boundary: a resumed run, and every report rebuilt from
 * `trials.jsonl`, read the spend as unmeasured. The class is "a field added to TrialArtifacts is
 * silently discarded by the journal", not the one dropped field, so this suite asserts the
 * sanitizer is field-preserving by construction rather than listing the fields it must keep.
 *
 * What it does not catch: a backend that never populates `usage` in the first place, and whether
 * the journal file itself is fsynced.
 */
import { describe, expect, it } from "bun:test";
import type { TrialArtifacts } from "../../engine/contracts";
import { sanitizeArtifacts, sanitizeTrialRecord } from "../../engine/run-journal";
import type { TrialResultRecord } from "../../engine/run-record";
import { RAW_OUTPUT_MAX_BYTES } from "../../engine/trial-deadline";

/** Every field TrialArtifacts declares, each with a distinguishable value. */
const fullArtifacts: TrialArtifacts = {
	logPaths: ["/runs/r1/t1/agent.log"],
	trialDir: "/runs/r1/t1",
	rawOutput: "tail of the agent output",
	filePaths: { patch: "/runs/r1/t1/patch.diff" },
	usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 50, costUsd: 0.0731, durationSec: 42.5 },
	extra: { timedOut: false, exitCode: 0 },
};

describe("sanitizing a trial's artifacts", () => {
	it("keeps every field it was given", () => {
		const sanitized = sanitizeArtifacts(fullArtifacts);
		expect(sanitized).toBeDefined();
		// Swept from the input, so a field added to TrialArtifacts is covered the moment the
		// fixture above declares it, and a rebuild that enumerates fields fails here.
		expect(Object.keys(sanitized ?? {}).sort()).toEqual(Object.keys(fullArtifacts).sort());
		expect(sanitized).toEqual(fullArtifacts);
	});

	it("keeps the measured spend a later reader has no other source for", () => {
		expect(sanitizeArtifacts(fullArtifacts)?.usage).toEqual(fullArtifacts.usage);
	});

	it("bounds only the raw output, keeping its tail", () => {
		const oversized = `${"a".repeat(RAW_OUTPUT_MAX_BYTES)}THE-END`;
		const sanitized = sanitizeArtifacts({ ...fullArtifacts, rawOutput: oversized });

		expect(sanitized?.rawOutput?.length).toBe(RAW_OUTPUT_MAX_BYTES);
		expect(sanitized?.rawOutput?.endsWith("THE-END")).toBe(true);
		expect(sanitized?.usage).toEqual(fullArtifacts.usage);
	});

	it("passes absent artifacts through as absent", () => {
		expect(sanitizeArtifacts(undefined)).toBeUndefined();
	});
});

describe("sanitizing a settled trial record", () => {
	it("carries the artifacts, and their usage, into the journalled record", () => {
		const record: TrialResultRecord = {
			cell: { variant: "baseline", suite: "deep-swe", task: "t1", repeat: 1 },
			score: { reward: 1, partial: null, error: null, usage: null, extra: {} },
			artifacts: fullArtifacts,
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:10:00.000Z",
			durationMs: 600_000,
		};

		const sanitized = sanitizeTrialRecord(record);

		expect(sanitized.artifacts).toEqual(fullArtifacts);
		// A round trip through the journal's own encoding must not lose it either.
		expect(JSON.parse(JSON.stringify(sanitized)).artifacts.usage).toEqual(fullArtifacts.usage);
	});
});
