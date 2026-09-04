/**
 * WHY: The incremental cost probe exists because live Harbor trial transcripts
 * can reach gigabytes. Re-reading the whole file on every polling tick blocked
 * the event loop for seconds. This suite proves the cost probe reads only
 * newly appended bytes across successive calls and does not re-parse already
 * consumed data.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dropCostProbe, probeTrialCost, resetCostProbes } from "../../../backends/harbor/cost-probe";

describe("a cost probe reads only appended bytes across calls", () => {
	let tmpDir: string;
	let logPath: string;

	beforeEach(() => {
		resetCostProbes();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-probe-test-"));
		logPath = path.join(tmpDir, "agent.jsonl");
	});

	afterEach(() => {
		dropCostProbe(logPath);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("accumulates spend and token counts across appended lines without re-parsing earlier bytes", () => {
		const line1 = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20, cost: { total: 0.005 } },
			},
		});
		fs.writeFileSync(logPath, `${line1}\n`);

		const firstProbe = probeTrialCost(logPath);
		expect(firstProbe).not.toBeNull();
		expect(firstProbe?.offset).toBe(Buffer.byteLength(`${line1}\n`));
		expect(firstProbe?.tokIn).toBe(120); // input + cacheRead
		expect(firstProbe?.tokOut).toBe(50);
		expect(firstProbe?.tokCache).toBe(20);
		expect(firstProbe?.costUsd).toBeCloseTo(0.005, 5);

		const line2 = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 200, output: 80, cacheRead: 30, cost: { total: 0.01 } },
			},
		});
		fs.appendFileSync(logPath, `${line2}\n`);

		const secondProbe = probeTrialCost(logPath);
		expect(secondProbe).not.toBeNull();
		expect(secondProbe?.offset).toBe(Buffer.byteLength(`${line1}\n${line2}\n`));
		// If line1 were re-parsed, tokIn would be 120 + 120 + 230 = 470; it must be 120 + 230 = 350
		expect(secondProbe?.tokIn).toBe(350);
		expect(secondProbe?.tokOut).toBe(130);
		expect(secondProbe?.tokCache).toBe(50);
		expect(secondProbe?.costUsd).toBeCloseTo(0.015, 5);
	});

	it("returns identical probe state without file I/O when the file size has not changed", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 50, output: 25, cacheRead: 0, cost: { total: 0.002 } },
			},
		});
		fs.writeFileSync(logPath, `${line}\n`);

		const probe1 = probeTrialCost(logPath);
		const initialOffset = probe1?.offset;
		expect(initialOffset).toBeGreaterThan(0);

		const probe2 = probeTrialCost(logPath);
		expect(probe2).toBe(probe1);
		expect(probe2?.offset).toBe(initialOffset);
		expect(probe2?.tokIn).toBe(50);
	});

	it("handles partial line writes by carrying the remainder to the next read", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 80, output: 40, cacheRead: 10, cost: { total: 0.004 } },
			},
		});

		// Write only half of the JSON line (no trailing newline)
		const part1 = line.slice(0, 30);
		const part2 = line.slice(30);
		fs.writeFileSync(logPath, part1);

		const probe1 = probeTrialCost(logPath);
		// Incomplete JSON cannot produce usage yet, and nothing measured is absent rather than zero.
		expect(probe1?.tokIn).toBeNull();
		expect(probe1?.costUsd).toBeNull();
		expect(probe1?.remainder.length).toBe(30);

		// Complete the line
		fs.appendFileSync(logPath, `${part2}\n`);

		const probe2 = probeTrialCost(logPath);
		expect(probe2?.tokIn).toBe(90);
		expect(probe2?.tokOut).toBe(40);
		expect(probe2?.tokCache).toBe(10);
		expect(probe2?.costUsd).toBeCloseTo(0.004, 5);
		expect(probe2?.remainder.length).toBe(0);
	});
});
