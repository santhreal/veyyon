/**
 * packages/coding-agent/test/task/topic-replenishment.test.ts
 *
 * Targeted proof test suite for native topic replenishment, recovery reconciliation,
 * memory admission, and atomic ticket dispatch contract.
 */

import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as topicReplenishmentModule from "../../src/task/topic-replenishment";
import {
	checkMemoryAdmission,
	claimNextAuthorizedTicket,
	completeClaimedTicket,
	FileLock,
	getGlobalReplenishmentEngine,
	isValidAuthorization,
	recordNativeDispatch,
	rollbackClaimedTicket,
	reconcileRunningTopics,
	resolveTopicName,
	RUNNABLE_TOPIC_NAMES,
	setGlobalReplenishmentEngine,
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

	// Test 4: FileLock - real two-process mutual exclusion against Python ledger locking (Finding 4)
	{
		console.log("Test 4: FileLock - real two-process mutual exclusion against Python ledger locking");
		const testDir = path.join(os.tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.promises.mkdir(testDir, { recursive: true });
		const targetFile = path.join(testDir, "test.json");
		const lockFile = `${targetFile}.lock`;
		const python = process.env.PYTHON_EXECUTABLE || process.env.PYTHON || "python";
		const bridgeScript = path.resolve("packages/coding-agent/src/task/native-ledger-bridge.py");

		// 1. Start a separate Python process (Process 1) holding the OS lock
		const p1 = spawn(
			python,
			[
				bridgeScript,
				"hold-lock",
				"--lock-path",
				lockFile,
				"--duration",
				"4",
				"--ready-signal",
				"LOCKED",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		// Wait for P1 to acquire the lock
		const { promise: p1Acquired, resolve: p1Resolve, reject: p1Reject } = Promise.withResolvers<void>();
		p1.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("LOCKED")) p1Resolve();
		});
		p1.on("error", p1Reject);
		p1.on("close", code => {
			p1Reject(new Error(`P1 exited prematurely with code ${code}`));
		});
		await p1Acquired;

		// 2. While Python holds the lock, TypeScript attempt to acquire must fail/timeout
		const lockTs = new FileLock(targetFile);
		let tsAcquisitionBlocked = false;
		try {
			await lockTs.acquire(400); // short timeout
		} catch (err) {
			tsAcquisitionBlocked = true;
			console.log("  [P1 held lock] TS acquisition correctly timed out:", String(err).slice(0, 70));
		}
		assert.equal(tsAcquisitionBlocked, true, "TypeScript must be blocked while Python holds lock");

		// 3. Release Python process 1
		p1.kill();
		await once(p1, "close");

		// 4. TypeScript acquires the lock
		await lockTs.acquire(5000);
		console.log("  [TS acquired lock]");

		// 5. While TypeScript holds the lock, a concurrent Python child process must be blocked
		const p2 = spawn(
			python,
			[
				bridgeScript,
				"hold-lock",
				"--lock-path",
				lockFile,
				"--duration",
				"0.1",
				"--timeout",
				"0.4",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const [p2ExitCode] = (await once(p2, "close")) as [number];
		assert.notEqual(p2ExitCode, 0, "Concurrent Python process must fail to acquire while TS holds lock");
		console.log("  [TS held lock] Concurrent Python child process blocked with non-zero exit code");

		// 6. Release lock from TypeScript
		await lockTs.release();

		// 7. After release, a new Python process acquires immediately
		const p3 = spawn(
			python,
			[
				bridgeScript,
				"hold-lock",
				"--lock-path",
				lockFile,
				"--duration",
				"0.1",
				"--timeout",
				"2.0",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const [p3ExitCode] = (await once(p3, "close")) as [number];
		assert.equal(p3ExitCode, 0, "Python process acquires lock successfully after TS release");
		await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
		console.log("  [PASS] FileLock proves bidirectional two-process OS-level mutual exclusion\n");
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
				"req-auth-string-false": {
					prompt: "Do work with negative string authorization",
					authorization: "false",
					state: "pending",
				},
				"req-auth-string-unauth": {
					prompt: "Do work with unapproved string authorization",
					authorization: "unauthorized",
					state: "pending",
				},
				"req-forbidden-prod": {
					prompt: "Deploy directly to target: production and branch main",
					target: "production",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "pending",
				},
				"req-forbidden-project": {
					prompt: "Harmless prompt text but forbidden project target",
					project: "zaraprptkegxqpvnsubu",
					authorization: "2026-09-06T10:00:00Z operator",
					state: "pending",
				},
				"req-forbidden-target": {
					prompt: "Harmless prompt text but forbidden target field",
					target: "production",
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
				"req-empty-auth": {
					prompt: "Task with empty auth object",
					authorization: {}, // empty object -> UNAUTHORIZED (Finding 5)
					state: "pending",
				},
				"req-decision-blocked": {
					prompt: "Task awaiting human operator decision",
					authorization: "2026-09-06T10:00:00Z operator",
					decision_blockers: ["staging-ci-access-403"], // human decision blocker -> BLOCKED (Finding 5)
					state: "pending",
				},
				"req-superboard-main": {
					prompt: "Update workflow engine in Superboard main branch",
					repo: "Wladefant/super-board",
					target: "main",
					topic: "Workflow",
					authorization: { timestamp: "2026-09-06T10:00:00Z", scope: "staging", authorized_by: "operator" },
					state: "pending",
					criteria: ["Engine updated"],
				},
				"req-prompt-mentioning-main": {
					prompt: "Notify Main orchestrator regarding completed verification and fix main menu layout",
					authorization: { timestamp: "2026-09-06T10:00:00Z", scope: "staging", authorized_by: "operator" },
					state: "pending",
					criteria: ["Menu layout fixed"],
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

		// Verify decision blockers and explicit blockers were tracked (Finding 5)
		assert.ok(claim1.blockedTopics && claim1.blockedTopics.length >= 3, "Must track blocked topics");
		const decBlocked = claim1.blockedTopics.find(b => b.ticketId === "req-decision-blocked");
		assert.ok(decBlocked, "Must track req-decision-blocked as blocked");
		assert.ok(decBlocked.reason.includes("Awaiting human decision on: staging-ci-access-403"));

		// Verify req-empty-auth was never claimed (Finding 5)
		assert.notEqual(claim1.ticket.id, "req-empty-auth");

		// Verify ledger was updated atomically on disk and history audit was appended (Finding 5)
		const rawUpdated = await fs.promises.readFile(ledgerPath, "utf-8");
		const updatedLedger = JSON.parse(rawUpdated) as LedgerFileShape;
		assert.equal(updatedLedger.requests["req-eligible-motion"].state, "implementation");
		assert.equal(updatedLedger.requests["req-eligible-motion"].owner, "native-worker-motion-1");
		assert.ok(Array.isArray(updatedLedger.requests["req-eligible-motion"].history), "History must be array");
		assert.equal(updatedLedger.requests["req-eligible-motion"].history?.length, 1);
		assert.equal(updatedLedger.requests["req-eligible-motion"].history?.[0].actor, "TopicReplenishmentEngine");
		assert.equal(updatedLedger.requests["req-eligible-motion"].history?.[0].to_state, "implementation");
		// Claim 2: Now claim the remaining eligible GUI ticket
		const claim2 = await claimNextAuthorizedTicket(ledgerPath, {
			coveredTopics: ["Motion"],
			workerId: "native-worker-gui-1",
		});
		assert.equal(claim2.claimed, true, "Must claim req-eligible-gui");
		assert.equal(claim2.ticket?.id, "req-eligible-gui");

		// Claim 3: Claim ticket with word 'main' in prompt (proves prompt words do not falsely block)
		const claim3 = await claimNextAuthorizedTicket(ledgerPath, {
			coveredTopics: ["Motion", "Desktop GUI"],
			workerId: "native-worker-menu-1",
		});
		assert.equal(claim3.claimed, true, "Prompt with word 'Main' must not be falsely blocked");
		assert.equal(claim3.ticket?.id, "req-prompt-mentioning-main");

		// Claim 4: Claim super-board@main ticket (proves Wladefant/super-board@main is allowed)
		const claim4 = await claimNextAuthorizedTicket(ledgerPath, {
			coveredTopics: ["Motion", "Desktop GUI", "Operator accountability"],
			workerId: "native-worker-superboard-1",
		});
		assert.equal(claim4.claimed, true, "Must claim super-board@main (authorized workflow repository)");
		assert.equal(claim4.ticket?.id, "req-superboard-main");
		// Claim 5: No remaining eligible tickets exist (all others are blocked/forbidden/cancelled/unauthorized)
		const claim5 = await claimNextAuthorizedTicket(ledgerPath);
		assert.equal(claim5.claimed, false, "Must not claim any unauthorized or blocked ticket");
		assert.ok(claim5.reason?.includes("No eligible authorized tickets"), "Must report reason");
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

		// Finding 2: Missing native executor must fail before claiming or incrementing counts
		const engineNoExec = new TopicReplenishmentEngine({ ledgerPath });
		let threwNoExec = false;
		try {
			await engineNoExec.replenish([]);
		} catch (err: unknown) {
			threwNoExec = true;
			assert.ok(String(err).includes("native task executor is required"));
		}
		assert.equal(threwNoExec, true, "Must throw immediately if no native executor is provided");

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
			structuredResult: {
				stage: "qa",
				request_id: "req-1",
				verdict: "pass",
				summary: "Tokens updated and verified",
				checks: [
					{
						name: "verify-tokens",
						command: ["git", "status"],
						exit_code: 0,
						observed: "clean",
						purpose: "verification",
					},
				],
			},
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
		// Finding 6: Recover failed spawn claims and prevent ticket leakage
		// Add failing ticket to ledger
		const preFailRaw = await fs.promises.readFile(ledgerPath, "utf-8");
		const preFailLedger = JSON.parse(preFailRaw) as LedgerFileShape;
		preFailLedger.requests["req-fail-test"] = {
			prompt: "Failing dispatch task",
			state: "pending",
			authorization: "2026-09-06T10:00:00Z operator",
		};
		await fs.promises.writeFile(ledgerPath, JSON.stringify(preFailLedger, null, 2), "utf-8");

		const engineFailing = new TopicReplenishmentEngine({
			ledgerPath,
			minFloor: 4,
			targetCount: 4,
			executor: async () => {
				throw new Error("Worker spawn failure: memory limit");
			},
		});

		const failOutcome = await engineFailing.replenish(currentRoster);
		assert.equal(failOutcome.status, "error");
		assert.ok(failOutcome.reason?.includes("claimed ticket rolled back to pending"));

		// Verify ticket was rolled back to pending, owner cleared, and blocker set
		const postFailRaw = await fs.promises.readFile(ledgerPath, "utf-8");
		const postFailLedger = JSON.parse(postFailRaw) as LedgerFileShape;
		const failReq = postFailLedger.requests["req-fail-test"];
		assert.equal(failReq.state, "pending", "Failed dispatch must roll back ticket to pending");
		assert.equal(failReq.owner, "", "Owner must be cleared on rollback");
		assert.ok(failReq.blocker?.includes("Worker spawn failure"), "Blocker must be set on ticket");
		assert.ok(Array.isArray(failReq.history) && failReq.history.length >= 2, "History must record claim and rollback");

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
	// Test 8: ToolSession callback wiring & canonical outcome validation
	{
		console.log("Test 8: ToolSession callback wiring & canonical outcome validation");
		const testDir = path.join(os.tmpdir(), `test-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.promises.mkdir(testDir, { recursive: true });
		const ledgerPath = path.join(testDir, "ledger.json");

		const lifecycleLedger: LedgerFileShape = {
			version: 2,
			created_at: new Date().toISOString(),
			requests: {
				"req-native-1": {
					id: "req-native-1",
					prompt: "Implement motion physics spring",
					topic: "Motion",
					state: "implementation",
					stage: "qa",
					owner: "worker-native-1",
					authorization: { timestamp: "2026-09-06T10:00:00Z", scope: "staging", authorized_by: "operator" },
				},
				"req-native-2": {
					id: "req-native-2",
					prompt: "Fix desktop GUI focus trap",
					topic: "Desktop GUI",
					state: "pending",
					authorization: { timestamp: "2026-09-06T10:00:00Z", scope: "staging", authorized_by: "operator" },
				},
			},
		};
		await fs.promises.writeFile(ledgerPath, JSON.stringify(lifecycleLedger, null, 2), "utf-8");

		// Focus Test A: exit0 + error stays unadvanced
		const resError = await completeClaimedTicket(ledgerPath, "req-native-1", {
			runId: "run-test-a",
			taskHandle: "agent://worker-native-1",
			exitCode: 0,
			error: "Unexpected runtime failure in worker",
			structuredResult: {
				stage: "qa",
				request_id: "req-native-1",
				verdict: "pass",
				summary: "Verification claimed ok but error logged",
				checks: [{ name: "c", command: ["git", "status"], exit_code: 0, observed: "ok", purpose: "verification" }],
			},
		});
		assert.equal(resError.ok, false, "Must not advance on exit0 when error is present");
		const postError = JSON.parse(await fs.promises.readFile(ledgerPath, "utf-8")) as LedgerFileShape;
		assert.equal(postError.requests["req-native-1"].state, "implementation", "State must remain implementation on error");
		assert.ok(postError.requests["req-native-1"].blocker?.includes("Unexpected runtime failure"));

		// Focus Test B: verdict fail stays unadvanced
		const resVerdictFail = await completeClaimedTicket(ledgerPath, "req-native-1", {
			runId: "run-test-b",
			taskHandle: "agent://worker-native-1",
			exitCode: 0,
			structuredResult: {
				stage: "qa",
				request_id: "req-native-1",
				verdict: "fail",
				summary: "Test suite failed",
				checks: [{ name: "c", command: ["test"], exit_code: 1, observed: "failed", purpose: "verification" }],
			},
		});
		assert.equal(resVerdictFail.ok, false, "Must not advance on failed verdict");
		const postFail = JSON.parse(await fs.promises.readFile(ledgerPath, "utf-8")) as LedgerFileShape;
		assert.equal(postFail.requests["req-native-1"].state, "implementation", "State must remain implementation on failed verdict");

		// Focus Test C: empty checks stays unadvanced
		const resEmptyChecks = await completeClaimedTicket(ledgerPath, "req-native-1", {
			runId: "run-test-c",
			taskHandle: "agent://worker-native-1",
			exitCode: 0,
			structuredResult: {
				stage: "qa",
				request_id: "req-native-1",
				verdict: "pass",
				summary: "Passed without checks",
				checks: [],
			},
		});
		assert.equal(resEmptyChecks.ok, false, "Must not advance on pass verdict with empty checks");
		const postEmpty = JSON.parse(await fs.promises.readFile(ledgerPath, "utf-8")) as LedgerFileShape;
		assert.equal(postEmpty.requests["req-native-1"].state, "implementation", "State must remain implementation on empty checks");

		// Focus Test D: valid native structured result advances via canonical validator
		const resValid = await completeClaimedTicket(ledgerPath, "req-native-1", {
			runId: "run-test-d",
			taskHandle: "agent://worker-native-1",
			exitCode: 0,
			structuredResult: {
				stage: "qa",
				request_id: "req-native-1",
				head_sha: "abcdef1234567890abcdef1234567890abcdef12",
				verdict: "pass",
				summary: "Verification succeeded",
				checks: [{ name: "check-spring", command: ["git", "status"], exit_code: 0, observed: "clean", purpose: "verification" }],
			},
		});
		assert.equal(resValid.ok, true, "Must advance on valid canonical structured result");
		const postValid = JSON.parse(await fs.promises.readFile(ledgerPath, "utf-8")) as LedgerFileShape;
		assert.equal(postValid.requests["req-native-1"].state, "QA", "Stage must advance to QA on valid implementation result");
		assert.equal(postValid.requests["req-native-1"].blocker, null, "Blocker must be cleared on success");

		// Focus Test E: full engine lifecycle with onWorkerComplete and automatic replenishment
		const newlyClaimed: string[] = [];
		const engine = new TopicReplenishmentEngine({
			ledgerPath,
			minFloor: 2,
			targetCount: 2,
			executor: async ticket => {
				newlyClaimed.push(ticket.id);
			},
		});
		setGlobalReplenishmentEngine(engine);
		assert.equal(getGlobalReplenishmentEngine(), engine, "Global engine must be registered");

		const completeEvent: SubagentCompleteEvent = {
			agentId: "worker-native-1",
			agentName: "fast",
			task: "Implement motion physics spring",
			status: "completed",
			exitCode: 0,
			ticketId: "req-native-1",
			structuredResult: {
				stage: "review",
				request_id: "req-native-1",
				verdict: "pass",
				summary: "Review passed",
				checks: [{ name: "c1", command: ["git", "status"], exit_code: 0, observed: "clean", purpose: "verification" }],
			},
		};

		const rosterAfter1: NativeActorSnapshot[] = [
			{ id: "worker-native-1", status: "running", role: "sub", task: "Motion" },
		];

		const after1Outcome = await engine.onWorkerComplete(completeEvent, rosterAfter1);
		assert.equal(after1Outcome.status, "replenished");
		assert.equal(after1Outcome.dispatchedCount, 1, "Must replenish 1 worker up to floor");
		assert.deepEqual(newlyClaimed, ["req-native-2"]);

		// Verify package exports
		const exported = topicReplenishmentModule;
		assert.ok(exported.TopicReplenishmentEngine, "TopicReplenishmentEngine must be exported");
		assert.ok(exported.reconcileRunningTopics, "reconcileRunningTopics must be exported");
		assert.ok(exported.claimNextAuthorizedTicket, "claimNextAuthorizedTicket must be exported");
		assert.ok(exported.checkMemoryAdmission, "checkMemoryAdmission must be exported");
		assert.ok(exported.FileLock, "FileLock must be exported");
		assert.ok(exported.isValidAuthorization, "isValidAuthorization must be exported");

		await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
		console.log("  [PASS] ToolSession callback wiring & canonical outcome validation verified\n");
	}

	console.log("=================================================");
	console.log("ALL 8 TOPIC REPLENISHMENT TESTS PASSED 100%!");
	console.log("=================================================");
}

runTests().catch(err => {
	console.error("Test failure:", err);
	process.exit(1);
});
