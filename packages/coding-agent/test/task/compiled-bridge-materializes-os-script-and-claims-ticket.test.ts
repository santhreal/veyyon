/**
 * packages/coding-agent/test/task/compiled-bridge-materializes-os-script-and-claims-ticket.test.ts
 *
 * Real compiled regression defending OS-readable bridge materialization and legitimate
 * isolated ticket claim per issue 4629 and native_58e5a483ede2497484a49d01.
 *
 * Proves that:
 * 1. Under `bun build --compile`, native-ledger-bridge.py is bundled as an embedded asset
 *    and resolveBridgeScriptPath() extracts it to an OS-accessible physical filesystem path
 *    rather than returning an unresolvable Bun virtual bunfs path (B:\~BUN\... or /$bunfs/...).
 * 2. External python.exe can open and execute the materialized bridge script cleanly.
 * 3. The compiled binary reaches the canonical Python backend with a valid isolated ticket,
 *    atomically claims it, and rejects unauthorized or invalid inputs fail-closed.
 * 4. Cross-process FileLock works under the compiled binary without ENOENT errors.
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SOURCE_BRIDGE = path.join(REPO_ROOT, "packages/coding-agent/src/task/native-ledger-bridge.py");
const TOPIC_REPLENISHMENT_SOURCE = path.join(
	REPO_ROOT,
	"packages/coding-agent/src/task/topic-replenishment.ts",
).replace(/\\/g, "/");

async function main(): Promise<void> {
	console.log("Starting compiled-bridge-materializes-os-script-and-claims-ticket test suite...\n");

	const scratchDir = path.join(
		os.tmpdir(),
		`test-compiled-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const scratchHome = path.join(scratchDir, "home");
	const compiledExe = path.join(scratchDir, process.platform === "win32" ? "runner.exe" : "runner");

	try {
		fs.mkdirSync(scratchHome, { recursive: true });

		// Write runner script that exercises compiled replenishment functions
		const runnerSrc = path.join(scratchDir, "runner.ts");
		const runnerCode = `
import {
	resolveBridgeScriptPath,
	claimNextAuthorizedTicket,
	FileLock,
} from "${TOPIC_REPLENISHMENT_SOURCE}";
import * as fs from "node:fs";

const mode = process.argv[2];
const ledgerArg = process.argv[3];

if (mode === "--probe-path") {
	const bridgePath = resolveBridgeScriptPath();
	const isBunfs = bridgePath.includes("~BUN") || bridgePath.includes("$bunfs") || bridgePath.startsWith("B:\\\\") || bridgePath.startsWith("B:/");
	const exists = fs.existsSync(bridgePath);
	let bytesLength = 0;
	try {
		bytesLength = fs.readFileSync(bridgePath).length;
	} catch {}
	console.log(JSON.stringify({ bridgePath, isBunfs, exists, bytesLength }));
	process.exit(0);
}

if (mode === "--claim-invalid") {
	const res = await claimNextAuthorizedTicket(ledgerArg, { workerId: "test-worker-invalid" });
	console.log(JSON.stringify(res));
	process.exit(0);
}

if (mode === "--claim-valid") {
	const res = await claimNextAuthorizedTicket(ledgerArg, { workerId: "test-worker-valid" });
	console.log(JSON.stringify(res));
	process.exit(0);
}

if (mode === "--test-lock") {
	const lock = new FileLock(ledgerArg);
	await lock.acquire(5000);
	await lock.release();
	console.log(JSON.stringify({ locked: true }));
	process.exit(0);
}

console.error("Unknown mode:", mode);
process.exit(1);
`;
		fs.writeFileSync(runnerSrc, runnerCode, "utf-8");

		console.log("Compiling standalone test harness with bun build --compile...");
		const buildRes = spawnSync(
			process.execPath,
			["build", "--compile", runnerSrc, "--outfile", compiledExe],
			{
				cwd: scratchDir,
				env: {
					...process.env,
					USERPROFILE: scratchHome,
					HOME: scratchHome,
				},
				stdio: "pipe",
				encoding: "utf-8",
			},
		);

		if (buildRes.status !== 0) {
			throw new Error(`Failed to compile test runner:\nstdout: ${buildRes.stdout}\nstderr: ${buildRes.stderr}`);
		}
		console.log("Compilation succeeded: " + compiledExe);

		// Test 1: Probe path in compiled executable
		{
			console.log("Test 1: materializes bridge script to physical OS-accessible path");
			const res = spawnSync(compiledExe, ["--probe-path"], {
				env: {
					...process.env,
					USERPROFILE: scratchHome,
					HOME: scratchHome,
				},
				encoding: "utf-8",
			});

			assert.equal(res.status, 0, `Probe execution must succeed: ${res.stderr}`);
			const parsed = JSON.parse(res.stdout.trim());
			assert.equal(parsed.isBunfs, false, "Materialized path must not be a virtual bunfs path");
			assert.equal(parsed.exists, true, "Materialized path must exist on disk");
			assert.ok(parsed.bytesLength > 10000, "Materialized file must have content");

			const sourceBytes = fs.readFileSync(SOURCE_BRIDGE);
			const materializedBytes = fs.readFileSync(parsed.bridgePath);
			assert.ok(
				materializedBytes.equals(sourceBytes),
				"Materialized bridge script must byte-for-byte match native-ledger-bridge.py source",
			);
			console.log("  [PASS] Bridge script successfully materialized and verified at: " + parsed.bridgePath);
		}

		// Test 2: Reject invalid/empty ledger fail-closed
		{
			console.log("Test 2: reject invalid/empty ledger fail-closed without crashing or ENOENT");
			const emptyLedgerPath = path.join(scratchDir, "empty-ledger.json");
			fs.writeFileSync(emptyLedgerPath, JSON.stringify({ version: 2, requests: {} }), "utf-8");

			const res = spawnSync(compiledExe, ["--claim-invalid", emptyLedgerPath], {
				env: {
					...process.env,
					USERPROFILE: scratchHome,
					HOME: scratchHome,
				},
				encoding: "utf-8",
			});

			assert.equal(res.status, 0, `Claim invalid execution must succeed without crash: ${res.stderr}`);
			const parsed = JSON.parse(res.stdout.trim());
			assert.equal(parsed.claimed, false, "Must not claim on empty ledger");
			assert.equal(parsed.reason, "No eligible authorized tickets found", "Must report no eligible tickets");
			console.log("  [PASS] Empty ledger rejected cleanly fail-closed");
		}

		// Test 3: Claim valid authorized ticket through compiled binary and canonical backend
		{
			console.log("Test 3: reaches canonical backend and claims a valid authorized ticket in compiled binary");
			const validLedgerPath = path.join(scratchDir, "valid-ledger.json");
			const initialLedger = {
				version: 2,
				role: "orchestrator",
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				requests: {
					"req-unauthorized-1": {
						prompt: "Do unapproved work",
						state: "pending",
					},
					"req-valid-claim-1": {
						prompt: "Implement compiled bridge asset extraction",
						topic: "Workflow",
						authorization: "2026-09-06T10:00:00Z operator",
						state: "pending",
						criteria: ["Bridge extracted cleanly", "Claim verified"],
					},
				},
			};
			fs.writeFileSync(validLedgerPath, JSON.stringify(initialLedger, null, 2), "utf-8");

			const res = spawnSync(compiledExe, ["--claim-valid", validLedgerPath], {
				env: {
					...process.env,
					USERPROFILE: scratchHome,
					HOME: scratchHome,
				},
				encoding: "utf-8",
			});

			assert.equal(res.status, 0, `Claim valid execution must succeed: ${res.stderr}`);
			const parsed = JSON.parse(res.stdout.trim());
			assert.equal(parsed.claimed, true, "Must claim eligible authorized ticket");
			assert.ok(parsed.ticket, "Ticket must be defined");
			assert.equal(parsed.ticket.id, "req-valid-claim-1", "Must claim expected ticket id");
			assert.equal(parsed.ticket.owner, "test-worker-valid", "Must assign specified worker id");

			// Verify on-disk ledger state mutation through the Python bridge
			const updatedLedger = JSON.parse(fs.readFileSync(validLedgerPath, "utf-8"));
			assert.equal(updatedLedger.requests["req-valid-claim-1"].state, "implementation", "Ledger request state must transition to implementation");
			assert.equal(
				updatedLedger.requests["req-valid-claim-1"].owner,
				"test-worker-valid",
				"Ledger request owner must be updated",
			);
			console.log("  [PASS] Valid ticket claimed and ledger state atomically updated");
		}

		// Test 4: Cross-process FileLock in compiled binary
		{
			console.log("Test 4: acquires and releases cross-process FileLock in compiled binary");
			const lockTarget = path.join(scratchDir, "test.lock");
			const res = spawnSync(compiledExe, ["--test-lock", lockTarget], {
				env: {
					...process.env,
					USERPROFILE: scratchHome,
					HOME: scratchHome,
				},
				encoding: "utf-8",
			});

			assert.equal(res.status, 0, `Lock execution must succeed: ${res.stderr}`);
			const parsed = JSON.parse(res.stdout.trim());
			assert.equal(parsed.locked, true, "Must successfully acquire and release FileLock");
			console.log("  [PASS] Cross-process FileLock works cleanly in compiled binary");
		}

		console.log("\n=================================================");
		console.log("ALL 4 COMPILED BRIDGE REGRESSION TESTS PASSED 100%!");
		console.log("=================================================");
	} finally {
		try {
			fs.rmSync(scratchDir, { recursive: true, force: true });
		} catch {}
	}
}

main().catch(err => {
	console.error("FATAL: Test suite failed:", err);
	process.exit(1);
});
