/**
 * WHY: In `storage.ts`, `markRunCompleted` and `markRunLogged` previously performed
 * unconstrained SQL `UPDATE` statements by run id without checking whether the run
 * was already abandoned (`abandoned_at IS NOT NULL`) or already logged (`status IS NOT NULL`).
 * As a result, an abandoned run could have its completion metrics updated or be
 * resurrected into an active logged status, and an already-logged run could be overwritten
 * by a duplicate log call.
 *
 * The class it closes: any invalid lifecycle state transition in autoresearch storage
 * (completing or logging an abandoned run, or double-logging a run).
 *
 * What it does not catch: concurrent multi-process SQLite transactions that bypass
 * the storage class.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AutoresearchStorage,
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	type SessionRow,
} from "@veyyon/coding-agent/autoresearch/storage";
import { TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

afterEach(() => {
	vi.restoreAllMocks();
});

let dbOverride: TempDir;
let storage: AutoresearchStorage;
let session: SessionRow;

beforeEach(async () => {
	dbOverride = TempDir.createSync("@pi-storage-state-");
	process.env.VEYYON_AUTORESEARCH_DB_DIR = dbOverride.path();
	storage = await openAutoresearchStorage(dbOverride.path());
	session = storage.openSession({
		name: "test-session",
		goal: "test goal",
		primaryMetric: "ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: "bash autoresearch.sh",
		branch: "main",
		baselineCommit: "abc1234",
		maxIterations: 10,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
	});
});

afterEach(async () => {
	delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
	closeAllAutoresearchStorages();
	await dbOverride.remove();
});

afterAll(() => {
	closeAllAutoresearchStorages();
});

describe("AutoresearchStorage run state transitions", () => {
	it("refuses markRunCompleted when run was abandoned", () => {
		const run = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bash autoresearch.sh",
			logPath: "/tmp/log",
			preRunDirtyPaths: [],
			startedAt: Date.now(),
		});

		const abandoned = storage.abandonPendingRuns(session.id);
		expect(abandoned).toBe(1);

		expect(() =>
			storage.markRunCompleted({
				runId: run.id,
				completedAt: Date.now(),
				durationMs: 100,
				exitCode: 0,
				timedOut: false,
				parsedPrimary: 50,
				parsedMetrics: null,
				parsedAsi: null,
			}),
		).toThrow(/abandoned/i);
	});

	it("refuses markRunLogged when run was abandoned", () => {
		const run = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bash autoresearch.sh",
			logPath: "/tmp/log",
			preRunDirtyPaths: [],
			startedAt: Date.now(),
		});

		storage.abandonPendingRuns(session.id);

		expect(() =>
			storage.markRunLogged({
				runId: run.id,
				status: "keep",
				description: "resurrect abandoned",
				metric: 50,
				metrics: {},
				asi: null,
				commitHash: "def5678",
				confidence: null,
				modifiedPaths: [],
				scopeDeviations: [],
				justification: null,
				loggedAt: Date.now(),
			}),
		).toThrow(/abandoned/i);
	});

	it("refuses markRunLogged when run is already logged (duplicate logging)", () => {
		const run = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bash autoresearch.sh",
			logPath: "/tmp/log",
			preRunDirtyPaths: [],
			startedAt: Date.now(),
		});

		storage.markRunCompleted({
			runId: run.id,
			completedAt: Date.now(),
			durationMs: 100,
			exitCode: 0,
			timedOut: false,
			parsedPrimary: 50,
			parsedMetrics: null,
			parsedAsi: null,
		});

		storage.markRunLogged({
			runId: run.id,
			status: "keep",
			description: "initial log",
			metric: 50,
			metrics: {},
			asi: null,
			commitHash: "def5678",
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: Date.now(),
		});

		expect(() =>
			storage.markRunLogged({
				runId: run.id,
				status: "discard",
				description: "second log attempt",
				metric: 99,
				metrics: {},
				asi: null,
				commitHash: "def5678",
				confidence: null,
				modifiedPaths: [],
				scopeDeviations: [],
				justification: null,
				loggedAt: Date.now(),
			}),
		).toThrow(/already logged/i);
	});

	it("refuses markRunCompleted when run is already logged", () => {
		const run = storage.insertRun({
			sessionId: session.id,
			segment: 0,
			command: "bash autoresearch.sh",
			logPath: "/tmp/log",
			preRunDirtyPaths: [],
			startedAt: Date.now(),
		});

		storage.markRunLogged({
			runId: run.id,
			status: "keep",
			description: "logged directly",
			metric: 50,
			metrics: {},
			asi: null,
			commitHash: "def5678",
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: Date.now(),
		});

		expect(() =>
			storage.markRunCompleted({
				runId: run.id,
				completedAt: Date.now(),
				durationMs: 100,
				exitCode: 0,
				timedOut: false,
				parsedPrimary: 50,
				parsedMetrics: null,
				parsedAsi: null,
			}),
		).toThrow(/already logged/i);
	});
});
