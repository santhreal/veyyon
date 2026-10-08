/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * A Cursor turn ends for one of several reasons the wire states: `turnEnded`, a Connect end-stream
 * frame, HTTP/2 trailers, an HTTP refusal, an abort, or a missing credential. Each has its own
 * handler, and the turn's outcome is decided once, after all of them had their chance. The class
 * this closes is "a reason the wire gave is lost or outranked by a later one":
 *
 *   - an end-stream error fails the turn even when `turnEnded` came first;
 *   - the first failure is the one reported, not the last;
 *   - `grpc-status: 0` is success, and a nonzero status after `turnEnded` still fails the turn;
 *   - an abort that lands while the request is being built ends the turn as aborted, although the
 *     server would have finished it;
 *   - a missing key fails before any connection opens;
 *   - an HTTP refusal is reported by its status even when its trailers also fail, and its body is
 *     never read as model output.
 *
 * Every case drives the real `streamCursor` over a real HTTP/2 connection.
 *
 * WHAT IT DOES NOT CATCH: the order of two failures that arrive in separate reads, which the
 * transport, not this code, decides.
 */
import { afterEach, describe, expect, it } from "bun:test";
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
	await server?.close();
	server = undefined;
});

describe("a Cursor turn's outcome", () => {
	it("fails a turn whose end-stream frame carries an error, even after turnEnded", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream);
			stream.end(Buffer.concat([turnEndedFrame(), endStreamFrame({ code: "internal", message: "late failure" })]));
		});

		const { message } = await runCursorTurn(server.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("late failure");
	});

	it("reports the first failure when a second one follows it", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream);
			stream.end(
				Buffer.concat([
					endStreamFrame({ code: "internal", message: "first failure" }),
					endStreamFrame({ code: "internal", message: "second failure" }),
				]),
			);
		});

		const { message } = await runCursorTurn(server.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("first failure");
		expect(message.errorMessage).not.toContain("second failure");
	});

	it("finishes a turn whose trailers carry grpc-status 0", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream, { "grpc-status": "0" });
			stream.end(Buffer.concat([textDeltaFrame("done"), turnEndedFrame()]));
		});

		const { message } = await runCursorTurn(server.baseUrl);

		expect(message.stopReason).toBe("stop");
	});

	it("fails a turn whose trailers carry a nonzero grpc-status after turnEnded", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream, { "grpc-status": "3", "grpc-message": "trailer%20failure" });
			stream.end(Buffer.concat([textDeltaFrame("done"), turnEndedFrame()]));
		});

		const { message } = await runCursorTurn(server.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("trailer failure");
	});

	it("ends a turn as aborted when the abort lands while the request is being built", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream);
			stream.end(Buffer.concat([textDeltaFrame("finished anyway"), turnEndedFrame()]));
		});
		const controller = new AbortController();

		const { message } = await runCursorTurn(server.baseUrl, {
			apiKey: "test-token",
			signal: controller.signal,
			onPayload: () => {
				controller.abort();
				return undefined;
			},
		});

		expect(message.stopReason).toBe("aborted");
	});

	it("fails a turn with no API key before it opens a connection", async () => {
		server = await startCursorH2Server(({ stream }) => {
			respondConnect(stream);
			stream.end(turnEndedFrame());
		});

		const { message } = await runCursorTurn(server.baseUrl, {});

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("API key");
		expect(server.accepted).toBe(0);
	});

	it("reports a refusal by its HTTP status even when its trailers also fail", async () => {
		server = await startCursorH2Server(({ stream }) => {
			stream.respond({ ":status": 401, "content-type": "application/json" }, { waitForTrailers: true });
			stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "3", "grpc-message": "from-trailer" }));
			stream.end(JSON.stringify({ error: "token expired" }));
		});

		const { message } = await runCursorTurn(server.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("401");
		expect(message.errorMessage).toContain("token expired");
		expect(message.errorMessage).not.toContain("from-trailer");
	});

	it("never reads a refused response's body as model output", async () => {
		server = await startCursorH2Server(({ stream }) => {
			stream.respond({ ":status": 403, "content-type": "application/connect+proto" });
			stream.end(Buffer.concat([textDeltaFrame("not the model"), turnEndedFrame()]));
		});

		const { events, message } = await runCursorTurn(server.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("403");
		expect(events.filter(event => event.type.startsWith("text_"))).toEqual([]);
	});
});
