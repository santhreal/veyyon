/**
 * Regression: a browser target that failed to take the stealth user agent must
 * say so.
 *
 * `sendUserAgentOverride` applies the override through two CDP domains. Every
 * failure was swallowed: `Network.enable` by a bare `catch {}`, and both
 * `setUserAgentOverride` calls at `logger.debug`. So a target that kept its
 * headless user agent was indistinguishable from one that took the override.
 *
 * That is not cosmetic. The override is what stops a page detecting that it is
 * automated, so losing it means the page can serve different content, a
 * challenge, or a block, and the operator sees only the strange result with no
 * connection to the cause (Law 10).
 *
 * The two domains are redundant on purpose (`Emulation` is modern, `Network`
 * covers older targets), so ONE failing is normal and must stay quiet. Both
 * failing is the capability actually being lost, and that is the only case
 * worth a warning. Reporting the redundant miss would be the noise that trains
 * people to ignore these warnings, which is how the loud path stops working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sendUserAgentOverride, type UserAgentOverride } from "@veyyon/coding-agent/tools/browser/launch";
import { logger } from "@veyyon/utils";

const OVERRIDE: UserAgentOverride = {
	userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0",
	platform: "Linux x86_64",
	acceptLanguage: "en-US,en",
	userAgentMetadata: {
		brands: [{ brand: "Chromium", version: "120" }],
		fullVersion: "120.0.0.0",
		fullVersionList: [{ brand: "Chromium", version: "120.0.0.0" }],
		bitness: "64",
		platform: "Linux",
		platformVersion: "6.1.0",
		architecture: "x86",
		model: "",
		mobile: false,
	},
};

/** A CDP client that fails exactly the methods named, and records every call. */
function client(failing: string[]): {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		async send(method: string): Promise<unknown> {
			calls.push(method);
			if (failing.includes(method)) throw new Error(`${method} is not supported by this target`);
			return {};
		},
	};
}

describe("sendUserAgentOverride", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies the override through both domains and reports nothing", async () => {
		// The premise of every test below. A warning here would be noise on the
		// path that works, which is what makes the real warning ignorable.
		const cdp = client([]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(cdp.calls).toEqual(["Network.enable", "Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);
		expect(warnings).toEqual([]);
	});

	it("stays quiet when only the Network domain fails, because Emulation still applied it", async () => {
		// The redundancy working as designed. The user agent IS overridden, so
		// there is no capability loss to report.
		const cdp = client(["Network.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(warnings).toEqual([]);
	});

	it("stays quiet when only the Emulation domain fails, because Network still applied it", async () => {
		const cdp = client(["Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(warnings).toEqual([]);
	});

	it("still tries Emulation after Network fails, rather than stopping at the first error", async () => {
		// A `return` on the first failure would turn a survivable miss into a total
		// loss, so the ordering is worth pinning rather than assuming.
		const cdp = client(["Network.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(cdp.calls).toContain("Emulation.setUserAgentOverride");
	});

	it("reports the lost capability when BOTH domains fail", async () => {
		// THE case. Before, this logged twice at debug and the target silently
		// browsed as a headless automation client.
		const cdp = client(["Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			"The browser user-agent override could not be applied, so this target reports itself as automated",
		);
	});

	it("names the user agent that was meant to apply, so the operator can tell which target", async () => {
		const cdp = client(["Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(warnings[0]?.fields.userAgent).toBe(OVERRIDE.userAgent);
	});

	it("reports why each domain failed, not just that they did", async () => {
		// "It failed" sends the reader nowhere. The CDP error is the thing that
		// distinguishes an unsupported domain from a dead connection.
		const cdp = client(["Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		const failures = warnings[0]?.fields.failures as string[];
		expect(failures).toHaveLength(2);
		expect(failures[0]).toContain("Network: ");
		expect(failures[0]).toContain("not supported by this target");
		expect(failures[1]).toContain("Emulation: ");
	});

	it("tells the operator what the consequence is and what to do about it", async () => {
		// The failure is invisible in the product (a page just behaves oddly), so
		// the message has to connect the two.
		const cdp = client(["Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(String(warnings[0]?.fields.fix)).toContain("Sites may block or behave differently");
	});

	it("includes a Network.enable failure in the report when everything else also failed", async () => {
		// `Network.enable` was the one swallowed outright. On its own it is not an
		// override failure, but when the override IS lost it is the likeliest
		// explanation, so it belongs in the same report.
		const cdp = client(["Network.enable", "Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(String(warnings[0]?.fields.networkEnable)).toContain("Network.enable is not supported");
	});

	it("does not mention Network.enable when it succeeded", async () => {
		// A field that is always present teaches the reader to skip it.
		const cdp = client(["Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(warnings[0]?.fields).not.toHaveProperty("networkEnable");
	});

	it("does not warn when Network.enable fails but the override still applied", async () => {
		// `Emulation` does not need the Network domain, so this is a complete
		// success and must read as one.
		const cdp = client(["Network.enable", "Network.setUserAgentOverride"]);

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(warnings).toEqual([]);
	});

	it("resolves rather than throwing when every call fails", async () => {
		// It is called from a CDP event handler for every new target. Throwing
		// there would take down attachment handling for an override that is best
		// effort by nature.
		const cdp = client(["Network.enable", "Network.setUserAgentOverride", "Emulation.setUserAgentOverride"]);

		await expect(sendUserAgentOverride(cdp, OVERRIDE)).resolves.toBeUndefined();
	});

	it("passes the whole override through, including the client-hints metadata", async () => {
		// The metadata is what a modern site actually reads. Sending only the UA
		// string leaves a target that contradicts itself, which is more detectable
		// than not overriding at all.
		const sent: Array<Record<string, unknown> | undefined> = [];
		const cdp = {
			async send(_method: string, params?: Record<string, unknown>): Promise<unknown> {
				sent.push(params);
				return {};
			},
		};

		await sendUserAgentOverride(cdp, OVERRIDE);

		expect(sent[1]).toEqual(OVERRIDE as unknown as Record<string, unknown>);
		expect(sent[2]).toEqual(OVERRIDE as unknown as Record<string, unknown>);
	});
});
