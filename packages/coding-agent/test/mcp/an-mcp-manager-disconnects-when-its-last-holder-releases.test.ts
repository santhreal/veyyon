/**
 * WHY THIS SUITE EXISTS:
 *
 * A session-created MCP manager is shared by every top-level session in the process that is handed
 * it (the `/new` that keeps the previous conversation running). `manager-lease.ts` counts the holds
 * so the servers disconnect when the last holder releases, not when the first one does. The defects
 * this closes are the ways a count goes wrong: a release that disconnects while another session
 * still holds the manager, a release called twice that spends someone else's hold, a manager that
 * never disconnects, and a hold taken on a manager nobody in this process created, which would let a
 * session disconnect servers its caller owns.
 *
 * Every sequence of holds and releases over three holders is swept, so the property is checked for
 * each order rather than for the one the reported defect took.
 *
 * WHAT IT DOES NOT CATCH: a session that never calls its release. The lease cannot see a holder
 * that leaks; the session dispose path owns calling it.
 */
import { describe, expect, it } from "bun:test";
import type { MCPManager } from "../../src/mcp/manager";
import { holdCreatedMcpManager, holdSharedMcpManager } from "../../src/mcp/manager-lease";

function fakeManager(): { manager: MCPManager; disconnects: () => number } {
	let count = 0;
	const manager = {
		async disconnectAll() {
			count++;
		},
	} as unknown as MCPManager;
	return { manager, disconnects: () => count };
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [items.slice()];
	return items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]),
	);
}

describe("an MCP manager disconnects when its last holder releases", () => {
	it("disconnects once, on the last release, for every release order of three holders", async () => {
		for (const order of permutations([0, 1, 2])) {
			const { manager, disconnects } = fakeManager();
			const releases = [
				holdCreatedMcpManager(manager),
				holdSharedMcpManager(manager),
				holdSharedMcpManager(manager),
			];
			for (const [step, holder] of order.entries()) {
				const release = releases[holder];
				if (!release) throw new Error("a shared hold on a held manager was refused");
				await release();
				expect(disconnects(), `order ${order.join(",")} after release ${step + 1}`).toBe(step === 2 ? 1 : 0);
			}
		}
	});

	it("does not spend another holder's hold when one release is called twice", async () => {
		const { manager, disconnects } = fakeManager();
		const creator = holdCreatedMcpManager(manager);
		const joiner = holdSharedMcpManager(manager)!;

		await creator();
		await creator();
		expect(disconnects()).toBe(0);

		await joiner();
		await joiner();
		expect(disconnects()).toBe(1);
	});

	it("refuses a shared hold on a manager no session in this process created", () => {
		const { manager } = fakeManager();
		expect(holdSharedMcpManager(manager)).toBeUndefined();
	});

	it("refuses a shared hold once every holder has released", async () => {
		const { manager, disconnects } = fakeManager();
		await holdCreatedMcpManager(manager)();
		expect(disconnects()).toBe(1);
		expect(holdSharedMcpManager(manager)).toBeUndefined();
	});

	it("starts a fresh count when a released manager is created again", async () => {
		const { manager, disconnects } = fakeManager();
		await holdCreatedMcpManager(manager)();
		const second = holdCreatedMcpManager(manager);
		const joiner = holdSharedMcpManager(manager)!;
		await second();
		expect(disconnects()).toBe(1);
		await joiner();
		expect(disconnects()).toBe(2);
	});
});
