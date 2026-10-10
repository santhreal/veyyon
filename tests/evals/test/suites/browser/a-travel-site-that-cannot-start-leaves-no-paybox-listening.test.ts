/**
 * WHY: Skyway starts two servers, PayBox for its payment frame first and Skyway itself second. When
 * Skyway's server could not listen, the start failed with PayBox still listening, and nothing held a
 * handle to close it: the trial's port stayed open for the life of the process.
 *
 * The case fails the second listen and asserts the start fails with that error and PayBox no longer
 * accepts a connection.
 *
 * Not caught: a failure after both servers listen, which `finish` and `close` already cover.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Seeded } from "../../../engine/kit/seeded";
import * as webHost from "../../../engine/kit/web-host";
import { generateTravel } from "../../../suites/browser/apps/travel/data";
import { startTravelSite } from "../../../suites/browser/apps/travel/site";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Skyway", () => {
	it("closes PayBox when its own server cannot start", async () => {
		const listen = webHost.hostSite;
		const started: webHost.HostedSite[] = [];
		spyOn(webHost, "hostSite").mockImplementation(async handler => {
			if (started.length > 0) throw new Error("listen EADDRINUSE: not-a-real-port");
			const site = await listen(handler);
			started.push(site);
			return site;
		});
		try {
			await expect(startTravelSite(generateTravel(new Seeded(1)), 1)).rejects.toThrow("not-a-real-port");
			const [paybox] = started;
			if (!paybox) throw new Error("Skyway started no PayBox");
			await expect(fetch(`${paybox.origin}/`)).rejects.toThrow();
		} finally {
			await Promise.all(started.map(site => site.close()));
		}
	});
});
