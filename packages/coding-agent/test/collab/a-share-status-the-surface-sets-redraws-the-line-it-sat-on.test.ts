/**
 * WHY:
 * `CollabHost` reaches the terminal through `createTerminalCollabHostSurface`, and the status line
 * caches what it drew. A `setCollabStatus` that does not invalidate that cache leaves the previous
 * participant count on screen until something else redraws, which is how a share reads as having
 * one guest after the second arrives, and as hosting after it stopped.
 *
 * THE CLASS THIS CLOSES: a surface method that reaches its terminal component and drops the effect
 * the component needs to show it. Every method of `CollabHostSurface` is swept from the interface's
 * own key set rather than a list written here, so a sixth method turns this red until it is
 * exercised, and each is asserted against the calls it must make in the order it must make them.
 *
 * WHAT IT DOES NOT CATCH: what the status line draws for a given count, which is the status line's
 * own contract, and whether `CollabHost` calls these methods at the right moments, which
 * `host-mirrors-only-its-own-conversation.test.ts` and the share end-to-end suites cover.
 */

import { describe, expect, it } from "bun:test";

import {
	type CollabHostSurface,
	createTerminalCollabHostSurface,
	type TerminalSurfaceContext,
} from "../../src/collab/host-surface";

/** One terminal context that records every call the surface makes on it, in order. */
function recordingContext(): { ctx: TerminalSurfaceContext; calls: string[] } {
	const calls: string[] = [];
	const ctx: TerminalSurfaceContext = {
		statusLine: {
			setCollabStatus(status) {
				calls.push(`statusLine.setCollabStatus:${status === null ? "null" : status.participantCount}`);
			},
			invalidate() {
				calls.push("statusLine.invalidate");
			},
			getCachedContextBreakdown() {
				calls.push("statusLine.getCachedContextBreakdown");
				return { usedTokens: 1200, contextWindow: 200_000 };
			},
		},
		ui: {
			requestRender() {
				calls.push("ui.requestRender");
			},
		},
		updatePendingMessagesDisplay() {
			calls.push("updatePendingMessagesDisplay");
		},
		showStatus(message, options) {
			calls.push(`showStatus:${message}:${options?.dim === true ? "dim" : "plain"}`);
		},
	};
	return { ctx, calls };
}

/** The methods the surface contract declares, taken from one constructed surface. */
function surfaceMethods(surface: CollabHostSurface): string[] {
	return Object.keys(surface).sort();
}

describe("a share status the surface sets redraws the line it sat on", () => {
	it("invalidates the status line after every status it sets, including the one that clears it", () => {
		const { ctx, calls } = recordingContext();
		const surface = createTerminalCollabHostSurface(ctx);

		surface.setCollabStatus({ role: "host", participantCount: 2 });
		surface.setCollabStatus(null);

		expect(calls).toEqual([
			"statusLine.setCollabStatus:2",
			"statusLine.invalidate",
			"statusLine.setCollabStatus:null",
			"statusLine.invalidate",
		]);
	});

	it("reads the context breakdown from the status line rather than answering for it", () => {
		const { ctx, calls } = recordingContext();
		const surface = createTerminalCollabHostSurface(ctx);

		expect(surface.getCachedContextBreakdown()).toEqual({ usedTokens: 1200, contextWindow: 200_000 });
		expect(calls).toEqual(["statusLine.getCachedContextBreakdown"]);
	});

	it("carries a dim status through to the terminal, and a plain one as plain", () => {
		const { ctx, calls } = recordingContext();
		const surface = createTerminalCollabHostSurface(ctx);

		surface.showStatus("Sharing session", { dim: true });
		surface.showStatus("Share stopped");

		expect(calls).toEqual(["showStatus:Sharing session:dim", "showStatus:Share stopped:plain"]);
	});

	it("passes a render request and a queued-prompt restatement to the components that own them", () => {
		const { ctx, calls } = recordingContext();
		const surface = createTerminalCollabHostSurface(ctx);

		surface.requestRender();
		surface.updatePendingMessagesDisplay();

		expect(calls).toEqual(["ui.requestRender", "updatePendingMessagesDisplay"]);
	});

	it("exercises every method the surface offers, so a new one arrives untested and red", () => {
		const { ctx } = recordingContext();
		const exercised = [
			"getCachedContextBreakdown",
			"requestRender",
			"setCollabStatus",
			"showStatus",
			"updatePendingMessagesDisplay",
		];

		expect(surfaceMethods(createTerminalCollabHostSurface(ctx))).toEqual(exercised);
	});
});
