import { describe, expect, it } from "bun:test";
import { startServer } from "../src/server";

describe("stats server resource cleanup and validation", () => {
	it("starts and stops server cleanly closing server and db resources", async () => {
		const { port, stop } = await startServer(0);
		expect(port).toBeGreaterThan(0);

		// Ping an API route to exercise server and db connection
		const res = await fetch(`http://localhost:${port}/api/stats/overview`);
		expect(res.ok).toBe(true);

		// Stop server cleanly
		stop();

		// Subsequent requests should fail to connect
		let failed = false;
		try {
			await fetch(`http://localhost:${port}/api/stats/overview`, { signal: AbortSignal.timeout(500) });
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});

	it("rejects non-numeric request ID with 400 Bad Request", async () => {
		const { port, stop } = await startServer(0);
		try {
			const res = await fetch(`http://localhost:${port}/api/request/not-a-number`);
			expect(res.status).toBe(400);
		} finally {
			stop();
		}
	});

	it("ignores non-numeric limit query parameter without crashing", async () => {
		const { port, stop } = await startServer(0);
		try {
			const res = await fetch(`http://localhost:${port}/api/stats/recent?limit=not-a-number`);
			expect(res.ok).toBe(true);
		} finally {
			stop();
		}
	});
});
