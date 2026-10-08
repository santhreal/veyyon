/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * A Cursor turn starts a heartbeat interval, a liveness governor with its own probe timers, and an
 * HTTP/2 session. A process that runs one turn and exits, such as a print-mode run, stays alive for
 * as long as any of them does, and a long-lived process accumulates one set per turn. The class
 * this closes is "a turn that ended leaves something running": every timer the turn armed is
 * cleared and its connection is closed, whether the turn finished or failed, and whether or not the
 * server ended the stream itself.
 *
 * The turn releases its resources after it delivers the terminal event, so each case waits for the
 * server to see the connection close, which the turn does after it clears its timers.
 *
 * WHAT IT DOES NOT CATCH: a resource the turn holds that is neither a timer nor its HTTP/2 session.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CursorH2Server,
	endStreamFrame,
	respondConnect,
	runCursorTurn,
	startCursorH2Server,
	textDeltaFrame,
	turnEndedFrame,
} from "./helpers/cursor-h2-server";

let server: CursorH2Server | undefined;

afterEach(async () => {
	vi.useRealTimers();
	await server?.close();
	server = undefined;
});

describe("a finished Cursor turn", () => {
	// The clock is fake and never advanced: the turn ends on network events alone, so no heartbeat
	// or probe comes due, and every timer the turn armed is still counted until it is cleared.
	it.each([
		["finished", [textDeltaFrame("hello"), turnEndedFrame()], "stop"],
		["failed", [textDeltaFrame("hello"), endStreamFrame({ code: "internal", message: "broken" })], "error"],
	] as const)("leaves no timer pending once a %s turn has released", async (_label, frames, stopReason) => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream);
			stream.end(Buffer.concat(frames));
		});
		vi.useFakeTimers();
		const before = vi.getTimerCount();

		const { message } = await runCursorTurn(server.baseUrl);
		await server.sessionsClosed();

		expect(message.stopReason).toBe(stopReason);
		expect(vi.getTimerCount()).toBe(before);
	});

	it("closes a stream the server left open after it ended the turn", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream);
			stream.write(turnEndedFrame());
		});

		const { message } = await runCursorTurn(server.baseUrl);
		await server.sessionsClosed();

		expect(message.stopReason).toBe("stop");
	});
});
