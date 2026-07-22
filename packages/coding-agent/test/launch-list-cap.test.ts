import { describe, expect, it } from "bun:test";
import type { DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { toolContent } from "@veyyon/coding-agent/tools/launch";

// WHY THIS SUITE EXISTS (BACKLOG DOG-1)
// -------------------------------------
// `launch list` printed EVERY historical daemon, including long-dead jobs, with no
// pruning, so the output grew unbounded and wasted tokens on every call. The default
// list now shows all live daemons plus only the most-recent exited ones, and
// summarizes the rest as "N more exited daemons not shown". This test locks the cap.

const LIST_PARAMS = { op: "list" } as unknown as Parameters<typeof toolContent>[1];

function snapshot(name: string, state: DaemonSnapshot["state"], exitedAt?: number): DaemonSnapshot {
	return {
		name,
		id: name,
		state,
		createdAt: 1,
		startedAt: 1,
		exitedAt,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	};
}

describe("launch list caps the terminal tail (DOG-1)", () => {
	it("shows all live daemons and only the 10 most-recent exited, summarizing the rest", () => {
		const live = [snapshot("live-a", "running"), snapshot("live-b", "ready")];
		// 15 exited daemons with increasing exitedAt: exited-14 is the most recent.
		const exited = Array.from({ length: 15 }, (_, i) => snapshot(`exited-${i}`, "exited", 1000 + i));
		const text = toolContent({ op: "list", daemons: [...live, ...exited] }, LIST_PARAMS);

		// Both live daemons are always shown.
		expect(text).toContain("live-a");
		expect(text).toContain("live-b");
		// The 10 most-recent exited (exited-5 .. exited-14) are shown; older ones are not.
		expect(text).toContain("exited-14");
		expect(text).toContain("exited-5");
		expect(text).not.toContain("exited-4");
		expect(text).not.toContain("exited-0");
		// The remaining 5 are summarized, not printed.
		expect(text).toContain("5 more exited daemons not shown");
	});

	it("does not add a summary line when the exited count is within the cap", () => {
		const daemons = [snapshot("live", "running"), snapshot("done-1", "exited", 10), snapshot("done-2", "failed", 20)];
		const text = toolContent({ op: "list", daemons }, LIST_PARAMS);

		expect(text).toContain("live");
		expect(text).toContain("done-1");
		expect(text).toContain("done-2");
		expect(text).not.toContain("more exited daemons");
	});

	it("still reports no daemons when the list is empty", () => {
		expect(toolContent({ op: "list", daemons: [] }, LIST_PARAMS)).toBe("No daemons.");
	});
});
