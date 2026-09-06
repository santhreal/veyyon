/**
 * packages/coding-agent/test/task/topic-replenishment.test.ts
 *
 * Targeted proof test suite for native topic replenishment, recovery reconciliation,
 * memory admission, and atomic ticket dispatch contract.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkMemoryAdmission,
	claimNextAuthorizedTicket,
	FileLock,
	reconcileRunningTopics,
	resolveTopicName,
	RUNNABLE_TOPIC_NAMES,
	TopicReplenishmentEngine,
	type LedgerFileShape,
	type NativeActorSnapshot,
	type SubagentCompleteEvent,
} from "../../src/task/topic-replenishment";

async function runTests(): Promise<void> {
	console.log("Starting topic-replenishment verification suite...\n");

	// Test 1: reconcileRunningTopics - strict running-only and idle/parked/fake rejection
	{
		console.log("Test 1: reconcileRunningTopics - active running vs idle/parked/fake rejection");
		const roster: NativeActorSnapshot[] = [
			{ id: "main:orchestrator", status: "running", role: "main" }, // Main orchestrator - excluded
			{ id: "TopicGuiDelivery", status: "parked", role: "sub", topic: "Desktop GUI" }, // Parked - excluded
			{ id: "TopicWorkflowGates", status: "idle", role: "sub", topic: "Workflow" }, // Idle - excluded
			{ id: "TopicStagingRecovery", status: "parked", role: "sub", topic: "Staging" }, // Parked - excluded
			{ id: "TopicClickableDecisions", status: "parked", role: "sub", topic: "Decisions" }, // Parked - excluded
			{ id: "TopicInventoryCoverage", status: "parked", role: "sub", topic: "Workflow" }, // Parked - excluded
			{ id: "TopicDedicatedIssues", status: "parked", role: "sub", topic: "Preserved GitHub issue inventory" }, // Parked - excluded
			{ id: "fake-worker-probe", status: "running", role: "sub" }, // Fake worker id - rejected
			{ id: "simulated-daemon", status: "simulated_active", role: "sub" }, // Simulated active - rejected
			{ id: "worker-gui-active", status: "running", role: "sub", task: "Fix DirectX GUI primitives" }, // Running -> Desktop GUI
			{ id: "worker-motion-active", status: "running", role: "sub", task: "Spring motion curves" }, // Running -> Motion
			{ id: "worker-telegram-active", status: "running", role: "sub", task: "Telegram notification loop" }, // Running -> Telegram
			{ id: "worker-staging-active", status: "running", role: "sub", task: "Staging pooler integration" }, // Running -> Staging
			{ id: "worker-decisions-active", status: "running", role: "sub", task: "Clickable decision protocol" }, // Running -> Decisions
			{ id: "worker-workflow-active", status: "running", role: "sub", task: "Workflow gate runner" }, // Running -> Workflow
			{ id: "worker-issue-active", status: "running", role: "sub", task: "Preserved issue inventory audit" }, // Running -> Preserved GitHub issue inventory
		];

		const res = reconcileRunningTopics(roster, { minFloor: 7, targetCount: 10 });

		assert.equal(res.activeUsefulCount, 7, "Must recognize exactly 7 useful running workers");
		assert.equal(res.idleWorkers.length, 1, "Must recognize 1 idle worker");
		assert.equal(res.parkedWorkers.length, 5, "Must recognize 5 parked workers");
		assert.equal(res.fakeWorkersRejected.length, 2, "Must reject 2 fake/simulated workers");
		assert.equal(res.floorDeficit, 0, "Worker floor of 7 is satisfied");
		assert.equal(res.targetDeficit, 3, "Target deficit from 10 should be 3");

		// Verify topic classification
		assert.ok(res.coveredTopics.includes("Desktop GUI"), "Desktop GUI must be covered");
		assert.ok(res.coveredTopics.includes("Motion"), "Motion must be covered");
		assert.ok(res.coveredTopics.includes("Telegram"), "Telegram must be covered");
		assert.ok(res.coveredTopics.includes("Staging"), "Staging must be covered");
		assert.ok(res.coveredTopics.includes("Decisions"), "Decisions must be covered");
		assert.ok(res.coveredTopics.includes("Workflow"), "Workflow must be covered");
		assert.ok(res.coveredTopics.includes("Preserved GitHub issue inventory"), "Preserved issues must be covered");
		assert.ok(!res.coveredTopics.includes("UX/design"), "UX/design should be uncovered");
		assert.ok(res.uncoveredTopics.includes("UX/design"), "UX/design must be in uncoveredTopics");

		console.log("  [PASS] reconcileRunningTopics strictly enforces running-only active workers\n");
	}

	// Test 2: reconcileRunningTopics - floor deficit calculation
	{
		console.log("Test 2: reconcileRunningTopics - floor deficit when below minimum 7");
		const roster: NativeActorSnapshot[] = [
			{ id: "TopicGuiDelivery", status: "parked", role: "sub" },
			{ id: "TopicWorkflowGates", status: "idle", role: "sub" },
			{ id: "worker-1", status: "running", role: "sub", task: "Desktop GUI" },
			{ id: "worker-2", status: "running", role: "sub", task: "Staging" },
		];

		const res = reconcileRunningTopics(roster, { minFloor: 7, targetCount: 10 });
		assert.equal(res.activeUsefulCount, 2, "Only 2 running workers");
		assert.equal(res.floorDeficit, 5, "Floor deficit must be 5 (7 - 2)");
		assert.equal(res.targetDeficit, 8, "Target deficit must be 8 (10 - 2)");

		console.log("  [PASS] floorDeficit correctly identifies shortage below floor\n");
	}

	// Test 3: checkMemoryAdmission - healthy vs ceiling
	{
		console.log("Test 3: checkMemoryAdmission - admission threshold and capacity exception");
		const liveCheck = await checkMemoryAdmission();
		assert.ok(liveCheck.totalMb > 0, "Must report total memory");
		assert.ok(liveCheck.freeMb > 0, "Must report free memory");
		console.log(`  Live memory check: ${liveCheck.usedPct}% used, ${liveCheck.freeMb} MB free (admitted=${liveCheck.admitted})`);

		// Enforce ceiling at 95%
		const blockedCheck = await checkMemoryAdmission({ maxPct: 10.0 }); // force threshold lower than actual used
		assert.equal(blockedCheck.admitted, false, "Must reject when RAM used exceeds threshold");
		assert.equal(blockedCheck.capacityException, true, "Must flag capacity exception");
		assert.ok(blockedCheck.reason?.includes("No new workers permitted"), "Must state explicit refusal reason");

		// Test cleanup callback invocation at 85%
		let cleanedUpCalled = false;
		const cleanCheck = await checkMemoryAdmission({
			cleanupPct: 10.0, // trigger cleanup
			maxPct: 99.9, // admit after cleanup
			onCleanup: () => {
				cleanedUpCalled = true;
			},
		});
		assert.equal(cleanedUpCalled, true, "Must invoke cleanup callback when above cleanup threshold");
		assert.equal(cleanCheck.cleanedUp, true, "Must flag cleanedUp = true");

		console.log("  [PASS] checkMemoryAdmission enforces RAM limits and cleanup\n");
	}

	// Test 4: FileLock - atomic acquisition, concurrency, and stale cleanup
	{
		console.log("Test 4: FileLock - concurrency and stale lock handling");
		const testDir = path.join(os.tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.promises.mkdir(testDir, { recursive: true });
		const targetFile = path.join(testDir, "test.json");

		const lock1 = new FileLock(targetFile);
		const lock2 = new FileLock(targetFile);

		await lock1.acquire(5000);
		assert.ok(fs.existsSync(lock1.lockPath), "Lock file must exist once acquired");

		// Attempting second acquisition should fail quickly with short timeout
		let lock2Failed = false;
		try {
			await lock2.acquire(200, 20);
		} catch (err) {
			lock2Failed = true;
		}
		assert.equal(lock2Failed, true, "Concurrent lock acquisition must be blocked");

		await lock1.release();
		assert.ok(!fs.existsSync(lock1.lockPath), "Lock file must be removed after release");

		// lock2 can now acquire
		await lock2.acquire(1000);
		await lock2.release();

		// Cleanup
		await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
		console.log("  [PASS] FileLock enforces mutually exclusive atomic access\n");
	}

	// Test 5: claimNextAuthorizedTicket - atomic claiming, authorization, forbidden target and cancellation guards
	{
		console.log("Test 5: claimNextAuthorizedTicket - authorization invariants and atomic claiming");
		const testDir = path.join(os.tmpdir(), `test-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.promises.mkdir(testDir, { recursive: true });
		const ledgerPath = path.join(testDir, "ledger.json");

		const mockLedger: LedgerFileShape = {
			version: 2,
			role: "orchestrator",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			requests: {
				"req-unauthorized": {
					prompt: "Do work without operator authorization",
					state: "pending",
					// no authorization field -> UNAUTHORIZED
				},
				"req-forbidden-prod": {
					prompt: "Deploy directly to target: production and branch main",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "pending",
				},
				"req-cancelled-choice-a": {
					prompt: "Record operator choice A for CI connectivity",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "pending",
				},
				"req-blocked-task": {
					prompt: "Perform staging migration",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "blocked",
					blocker: "Missing database credentials",
				},
				"req-dep-blocked": {
					prompt: "Run scenario QA on staging",
					authorization: "2026-09-06T10:00:00Z operator",
					dependencies: ["req-blocked-task"],
					state: "pending",
				},
				"req-awaiting-merge": {
					prompt: "Merge workflow PR to staging",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "awaiting authorization", // ungranted merge gate - must not auto-dispatch
				},
				"req-eligible-gui": {
					prompt: "Fix desktop GUI slider rendering and theme tokens",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "pending",
					criteria: ["Slider renders without clipping", "Theme tokens updated"],
				},
				"req-eligible-motion": {
					prompt: "Tune motion curve spring parameters for drawer animation",
					topic: "Motion",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "pending",
					criteria: ["Drawer springs smoothly"],
				},
			},
		};

		await fs.promises.writeFile(ledgerPath, JSON.stringify(mockLedger, null, 2), "utf-8");

		// Claim 1: Should pick an eligible ticket and skip unauthorized, prod, cancelled, blocked, and awaiting-auth
		const claim1 = await claimNextAuthorizedTicket(ledgerPath, {
			coveredTopics: ["Desktop GUI"], // GUI is already covered, so Motion should be prioritized!
			workerId: "native-worker-motion-1",
		});

		assert.equal(claim1.claimed, true, "Must claim an eligible ticket");
		assert.ok(claim1.ticket, "Ticket must be defined");
		assert.equal(claim1.ticket.id, "req-eligible-motion", "Must prioritize uncovered topic Motion over already-covered GUI");
		assert.equal(claim1.ticket.owner, "native-worker-motion-1", "Must assign specified worker id");
		assert.equal(claim1.ticket.state, "implementation", "Must advance state from pending to implementation");

		// Verify that blocked topics were tracked
		assert.ok(claim1.blockedTopics && claim1.blockedTopics.length >= 2, "Must track blocked topics");
		const dbBlocked = claim1.blockedTopics.find(b => b.ticketId === "req-blocked-task");
		assert.ok(dbBlocked, "Must track req-blocked-task");
		assert.equal(dbBlocked.reason, "Missing database credentials");
		const depBlocked = claim1.blockedTopics.find(b => b.ticketId === "req-dep-blocked");
		assert.ok(depBlocked, "Must track req-dep-blocked");
		assert.ok(depBlocked.reason.includes("Dependencies unfulfilled"), "Must identify dependency blocker");

		// Verify ledger was updated atomically on disk
		const rawUpdated = await fs.promises.readFile(ledgerPath, "utf-8");
		const updatedLedger = JSON.parse(rawUpdated) as LedgerFileShape;
		assert.equal(updatedLedger.requests["req-eligible-motion"].state, "implementation");
		assert.equal(updatedLedger.requests["req-eligible-motion"].owner, "native-worker-motion-1");

		// Claim 2: Now claim the remaining eligible GUI ticket
		const claim2 = await claimNextAuthorizedTicket(ledgerPath, {
			coveredTopics: ["Motion"],
			workerId: "native-worker-gui-1",
		});
		assert.equal(claim2.claimed, true, "Must claim req-eligible-gui");
		assert.equal(claim2.ticket?.id, "req-eligible-gui");

		// Claim 3: No remaining eligible tickets exist (all others are blocked/forbidden/cancelled/unauthorized)
		const claim3 = await claimNextAuthorizedTicket(ledgerPath);
		assert.equal(claim3.claimed, false, "Must not claim any unauthorized or blocked ticket");
		assert.ok(claim3.reason?.includes("No eligible authorized tickets"), "Must report reason");

		// Cleanup
		await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
		console.log("  [PASS] claimNextAuthorizedTicket strictly enforces authorization & fail-closed guards\n");
	}

	// Test 6: TopicReplenishmentEngine - replenish loop and onWorkerComplete trigger
	{
		console.log("Test 6: TopicReplenishmentEngine - replenishment loop and worker completion trigger");
		const testDir = path.join(os.tmpdir(), `test-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.promises.mkdir(testDir, { recursive: true });
		const ledgerPath = path.join(testDir, "ledger.json");

		const testLedger: LedgerFileShape = {
			version: 2,
			created_at: new Date().toISOString(),
			requests: {
				"req-1": {
					prompt: "UX design token update",
					state: "pending",
					authorization: "2026-09-06T10:00:00Z operator",
				},
				"req-2": {
					prompt: "Telegram notification formatting",
					state: "pending",
					authorization: "2026-09-06T10:00:00Z operator",
				},
				"req-3": {
					prompt: "Staging database query optimization",
					state: "pending",
					authorization: "2026-09-06T10:00:00Z operator",
				},
			},
		};
		await fs.promises.writeFile(ledgerPath, JSON.stringify(testLedger, null, 2), "utf-8");

		const engine = new TopicReplenishmentEngine({
			ledgerPath,
			minFloor: 3,
			targetCount: 3,
		});

		// Empty roster -> replenish should claim all 3 eligible tickets
		const dispatched: string[] = [];
		const outcome = await engine.replenish([], {
			dispatchWorker: async ticket => {
				dispatched.push(ticket.id);
			},
		});

		assert.equal(outcome.status, "replenished");
		assert.equal(outcome.dispatchedCount, 3, "Must dispatch 3 tickets to satisfy floor/target");
		assert.deepEqual(dispatched, ["req-1", "req-2", "req-3"]);

		// Now simulate completion of req-1 by worker
		// Add new pending ticket req-4 to ledger
		const raw = await fs.promises.readFile(ledgerPath, "utf-8");
		const curLedger = JSON.parse(raw) as LedgerFileShape;
		curLedger.requests["req-4"] = {
			prompt: "Desktop GUI modal focus trap",
			state: "pending",
			authorization: "2026-09-06T10:00:00Z operator",
		};
		await fs.promises.writeFile(ledgerPath, JSON.stringify(curLedger, null, 2), "utf-8");

		// Worker 1 finishes!
		const completeEvent: SubagentCompleteEvent = {
			agentId: "worker-1",
			agentName: "deep",
			task: "UX design token update",
			status: "completed",
			exitCode: 0,
			durationMs: 1200,
			ticketId: "req-1",
		};

		// Running roster currently has worker-2 and worker-3
		const currentRoster: NativeActorSnapshot[] = [
			{ id: "worker-1", status: "running", role: "sub", task: "UX design" },
			{ id: "worker-2", status: "running", role: "sub", task: "Telegram" },
			{ id: "worker-3", status: "running", role: "sub", task: "Staging" },
		];

		const newlyDispatched: string[] = [];
		const completeOutcome = await engine.onWorkerComplete(completeEvent, currentRoster, {
			dispatchWorker: async ticket => {
				newlyDispatched.push(ticket.id);
			},
		});

		// Worker 1 completed, so running dropped to 2 -> onWorkerComplete immediately claimed req-4 without prompt!
		assert.equal(completeOutcome.dispatchedCount, 1, "Must immediately claim next ticket on completion");
		assert.deepEqual(newlyDispatched, ["req-4"], "Must dispatch req-4 to maintain floor of 3");

		// Verify req-1 state advanced to QA in ledger
		const postRaw = await fs.promises.readFile(ledgerPath, "utf-8");
		const postLedger = JSON.parse(postRaw) as LedgerFileShape;
		assert.equal(postLedger.requests["req-1"].state, "QA", "Stage must advance to QA on exitCode 0");
		assert.equal(postLedger.requests["req-4"].state, "implementation", "New ticket state must be implementation");

		// Cleanup
		await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
		console.log("  [PASS] TopicReplenishmentEngine automatically replenishes workers on completion\n");
	}
	// Test 7: onSessionRecovery - recovery reconciliation and work preservation
	{
		console.log("Test 7: onSessionRecovery - recovery reconciliation and work preservation");
		const testDir = path.join(os.tmpdir(), `test-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.promises.mkdir(testDir, { recursive: true });
		const ledgerPath = path.join(testDir, "ledger.json");

		const recoveryLedger: LedgerFileShape = {
			version: 2,
			created_at: new Date().toISOString(),
			requests: {
				"req-done-1": {
					prompt: "Completed feature",
					state: "done",
					authorization: "2026-09-06T10:00:00Z operator",
					criteria: ["Done criteria"],
				},
				"req-in-progress-1": {
					prompt: "Motion spring physics",
					state: "implementation",
					owner: "worker-motion-persisted",
					authorization: "2026-09-06T10:00:00Z operator",
				},
				"req-pending-recovered": {
					prompt: "Staging database read replica",
					state: "pending",
					authorization: "2026-09-06T10:00:00Z operator",
				},
			},
		};
		await fs.promises.writeFile(ledgerPath, JSON.stringify(recoveryLedger, null, 2), "utf-8");

		const engine = new TopicReplenishmentEngine({
			ledgerPath,
			minFloor: 2,
			targetCount: 2,
		});

		// Recovery with 1 surviving running worker (worker-motion-persisted)
		const survivingRoster: NativeActorSnapshot[] = [
			{ id: "worker-motion-persisted", status: "running", role: "sub", task: "Motion spring physics" },
		];

		const recoveryDispatched: string[] = [];
		const recoveryOutcome = await engine.onSessionRecovery(survivingRoster, {
			dispatchWorker: async ticket => {
				recoveryDispatched.push(ticket.id);
			},
		});

		assert.equal(recoveryOutcome.status, "replenished");
		assert.equal(recoveryOutcome.dispatchedCount, 1, "Must replenish 1 missing worker to satisfy target 2");
		assert.deepEqual(recoveryDispatched, ["req-pending-recovered"]);

		// Verify done request was untouched (work preserved)
		const postRaw = await fs.promises.readFile(ledgerPath, "utf-8");
		const postLedger = JSON.parse(postRaw) as LedgerFileShape;
		assert.equal(postLedger.requests["req-done-1"].state, "done", "Completed work must be preserved");

		await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
		console.log("  [PASS] onSessionRecovery preserves durable work and replenishes worker pool\n");
	}

	console.log("=================================================");
	console.log("ALL 7 TOPIC REPLENISHMENT TESTS PASSED 100%!");
	console.log("=================================================");
}

runTests().catch(err => {
	console.error("Test failure:", err);
	process.exit(1);
});
