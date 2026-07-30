/**
 * The release cutter may push only the exact tree approved by CI and Checks.
 *
 * If main advances during preparation, the atomic push must fail once. A retry
 * would rebase onto a tree the exact-SHA gate never examined.
 */
import { describe, expect, it } from "bun:test";
import { pushPreparedRelease } from "./release";

describe("exact-SHA release push", () => {
	it("tags and atomically pushes the one tree approved by the release gate", async () => {
		const events: string[] = [];

		await pushPreparedRelease("v1.2.3", {
			currentSha: async () => {
				events.push("sha");
				return "approved-main";
			},
			forceLocalTag: async tag => {
				events.push(`tag:${tag}`);
			},
			atomicPush: async (tag, sha) => {
				events.push(`push:${tag}:${sha}`);
			},
		});

		expect(events).toEqual(["sha", "tag:v1.2.3", "push:v1.2.3:approved-main"]);
	});

	it("propagates a rejected atomic push without rebasing or retrying", async () => {
		const rejection = new Error("main advanced");
		let attempts = 0;
		const outcome = pushPreparedRelease("v1.2.3", {
			currentSha: async () => "approved-main",
			forceLocalTag: async () => {},
			atomicPush: async () => {
				attempts++;
				throw rejection;
			},
		});

		await expect(outcome).rejects.toBe(rejection);
		expect(attempts).toBe(1);
	});
});
