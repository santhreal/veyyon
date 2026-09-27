/**
 * WHY: the bank starts two servers, the phone its codes reach first and the bank itself second.
 * When the bank's server could not listen, the start failed with the phone still listening, and
 * nothing held a handle to close it: the trial's port stayed open for the life of the process.
 *
 * The case fails the second listen and asserts the start fails with that error and the phone no
 * longer accepts a connection.
 *
 * Not caught: a failure after both servers listen, which `finish` and `close` already cover.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Seeded } from "../../../engine/kit/seeded";
import * as webHost from "../../../engine/kit/web-host";
import { generateBank } from "../../../suites/browser/apps/bank/data";
import { startBankSite } from "../../../suites/browser/apps/bank/site";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the bank", () => {
	it("closes its phone when its own server cannot start", async () => {
		const listen = webHost.hostSite;
		const started: webHost.HostedSite[] = [];
		spyOn(webHost, "hostSite").mockImplementation(async handler => {
			if (started.length > 0) throw new Error("listen EADDRINUSE: not-a-real-port");
			const site = await listen(handler);
			started.push(site);
			return site;
		});
		try {
			await expect(startBankSite(generateBank(new Seeded(1)), 1)).rejects.toThrow("not-a-real-port");
			const [phone] = started;
			if (!phone) throw new Error("the bank started no phone");
			await expect(fetch(`${phone.origin}/api/conversations`)).rejects.toThrow();
		} finally {
			await Promise.all(started.map(site => site.close()));
		}
	});
});
