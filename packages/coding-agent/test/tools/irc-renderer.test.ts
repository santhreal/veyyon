import { describe, expect, it } from "bun:test";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { IrcMessage } from "@veyyon/coding-agent/task/irc-bus";
import { getThemeByName } from "@veyyon/coding-agent/theme/theme";
import type { IrcDetails } from "@veyyon/coding-agent/tools/agent/irc";
import { type IrcViewArgs, type IrcViewResult, ircToolView } from "@veyyon/coding-agent/tools/agent/irc-view";
import { sanitizeText } from "@veyyon/utils";

async function theme() {
	const t = await getThemeByName("dark");
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n"))
		.split("\n")
		.map(l => l.trimEnd());

/** The card the terminal draws for a result, which is the view through the host's own drawing. */
async function card(result: IrcViewResult, args: IrcViewArgs, expanded = false): Promise<string[]> {
	const uiTheme = await theme();
	return lines(drawToolView(ircToolView.renderResult(result, { expanded }, args), uiTheme));
}

const msg = (overrides: Partial<IrcMessage>): IrcMessage => ({
	id: "7181122334455667789",
	from: "AuthLoader",
	to: "Main",
	body: "session-store rename is merged.",
	ts: Date.now() - 30_000,
	...overrides,
});

describe("the irc card for a send", () => {
	it("folds a single delivery outcome into the header and shows the awaited reply", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "send",
					from: "Main",
					to: "AuthLoader",
					receipts: [{ to: "AuthLoader", outcome: "revived" }],
					waited: msg({ body: "go ahead, auth.ts is yours." }),
				} satisfies IrcDetails,
			},
			{ op: "send", to: "AuthLoader", message: "Are you done with auth.ts?", await: true },
		);
		expect(rendered[0]).toContain("AuthLoader");
		expect(rendered[0]).toContain("revived");
		expect(rendered.some(line => line.includes("Are you done with auth.ts?"))).toBe(true);
		expect(rendered.some(line => line.includes("go ahead, auth.ts is yours."))).toBe(true);
	});

	it("lists per-recipient outcomes with error text when a broadcast partially fails", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "send",
					from: "Main",
					to: "all",
					receipts: [
						{ to: "AuthLoader", outcome: "woken" },
						{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' },
					],
				} satisfies IrcDetails,
			},
			{ op: "send", to: "all", message: "heads up" },
		);
		expect(rendered[0]).toContain("broadcast");
		expect(rendered[0]).toContain("1 delivered");
		expect(rendered[0]).toContain("1 failed");
		expect(rendered.some(line => line.includes("AuthLoader") && line.includes("woken"))).toBe(true);
		expect(rendered.some(line => line.includes("RateLimiter") && line.includes('unknown agent "RateLimiter"'))).toBe(
			true,
		);
	});

	it("flags an awaited send whose reply timed out", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "send",
					from: "Main",
					to: "AuthLoader",
					receipts: [{ to: "AuthLoader", outcome: "injected" }],
					waited: null,
				} satisfies IrcDetails,
			},
			{ op: "send", to: "AuthLoader", message: "ping", await: true },
		);
		expect(rendered[0]).toContain("no reply");
		expect(rendered.some(line => line.includes("No reply yet"))).toBe(true);
	});

	it("surfaces pre-delivery validation failures as an error detail", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: '`to` is required for op="send".' }],
				details: { op: "send", from: "Main" } satisfies IrcDetails,
				isError: true,
			},
			{ op: "send" },
		);
		expect(rendered.some(line => line.includes('`to` is required for op="send".'))).toBe(true);
	});
});

describe("the irc card for a wait", () => {
	it("renders the consumed message under a sender header", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: { op: "wait", from: "Main", waited: msg({}) } satisfies IrcDetails,
			},
			{ op: "wait", from: "AuthLoader" },
		);
		expect(rendered[0]).toContain("AuthLoader");
		expect(rendered.some(line => line.includes("session-store rename is merged."))).toBe(true);
	});

	it("marks a timed-out wait without inventing a message", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "No message from AuthLoader within 2m." }],
				details: { op: "wait", from: "Main", waited: null } satisfies IrcDetails,
			},
			{ op: "wait", from: "AuthLoader" },
		);
		expect(rendered[0]).toContain("timed out");
		expect(rendered.some(line => line.includes("No message from AuthLoader within 2m."))).toBe(true);
	});
});

describe("the irc card for an inbox", () => {
	it("lists each message with sender and body preview", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "inbox",
					from: "Main",
					inbox: [
						msg({ from: "AuthLoader", body: "bus landed." }),
						msg({ from: "RateLimiter", body: "receipts carry outcome.", replyTo: "7181122334455667791" }),
					],
				} satisfies IrcDetails,
			},
			{ op: "inbox", peek: true },
		);
		// The whole block, in order. Every row hangs from the house rail, including
		// the header; items carry no tree connectors and a message body is nested
		// detail indented by two spaces, with no quote glyph of its own.
		expect(rendered).toEqual([
			"▏ IRC inbox 2 messages · peek",
			"▏  AuthLoader just now",
			"▏    bus landed.",
			"▏  RateLimiter just now reply",
			"▏    receipts carry outcome.",
		]);
		for (const line of rendered) {
			expect(line).not.toMatch(/[├└│]/);
		}
	});

	it("marks only the message that is a reply", async () => {
		// The negative twin for the marker above: with neither message carrying a
		// `replyTo`, no row may claim to be one.
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "inbox",
					from: "Main",
					inbox: [msg({ from: "AuthLoader", body: "bus landed." })],
				} satisfies IrcDetails,
			},
			{ op: "inbox", peek: true },
		);

		expect(rendered).toEqual(["▏ IRC inbox 1 message · peek", "▏  AuthLoader just now", "▏    bus landed."]);
		for (const line of rendered) {
			expect(line).not.toMatch(/[├└│]/);
		}
	});
});

describe("the irc card for a peer list", () => {
	it("summarizes status counts and flags unread peers", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "list",
					from: "Main",
					peers: [
						{
							id: "RateLimiter",
							displayName: "task",
							kind: "sub",
							status: "parked",
							parentId: "Main",
							unread: 2,
							lastActivity: Date.now() - 12 * 60_000,
						},
						{
							id: "AuthLoader",
							displayName: "task",
							kind: "sub",
							status: "running",
							parentId: "Main",
							unread: 0,
							lastActivity: Date.now() - 2 * 60_000,
						},
					],
				} satisfies IrcDetails,
			},
			{ op: "list" },
		);
		expect(rendered[0]).toContain("1 running");
		expect(rendered[0]).toContain("1 parked");
		expect(rendered[0]).toContain("2 unread");
		// Running peers sort above parked ones regardless of input order.
		const authIndex = rendered.findIndex(line => line.includes("AuthLoader"));
		const rateIndex = rendered.findIndex(line => line.includes("RateLimiter"));
		expect(authIndex).toBeGreaterThan(0);
		expect(authIndex).toBeLessThan(rateIndex);
		expect(rendered.some(line => line.includes("RateLimiter") && line.includes("2 unread"))).toBe(true);
	});

	it("renders a peer's role displayName and current activity in the row", async () => {
		const rendered = await card(
			{
				content: [{ type: "text", text: "" }],
				details: {
					op: "list",
					from: "Main",
					peers: [
						{
							id: "AuthScout",
							displayName: "Auth-flow security reviewer",
							kind: "sub",
							status: "running",
							parentId: "Main",
							unread: 0,
							lastActivity: Date.now() - 5_000,
							activity: "auditing the token refresh path",
						},
					],
				} satisfies IrcDetails,
			},
			{ op: "list" },
		);
		const row = rendered.find(line => line.includes("AuthScout"));
		expect(row).toBeDefined();
		expect(row).toContain("Auth-flow security reviewer");
		expect(row).toContain("auditing the token refresh path");
		for (const line of rendered) {
			expect(line).not.toMatch(/[├└│]/);
		}
	});

	it("collapses peer roster with an overflow line when not expanded", async () => {
		const peers = Array.from({ length: 12 }, (_, i) => ({
			id: `Agent_${i + 1}`,
			displayName: "task",
			kind: "sub",
			status: "idle" as const,
			parentId: "Main",
			unread: 0,
			lastActivity: Date.now() - 10_000,
		}));
		const result: IrcViewResult = {
			content: [{ type: "text", text: "" }],
			details: { op: "list", from: "Main", peers } satisfies IrcDetails,
		};
		const rendered = await card(result, { op: "list" });
		expect(rendered.some(l => l.includes("… 4 more peers"))).toBe(true);
		for (const line of rendered) {
			expect(line).not.toMatch(/[├└│]/);
		}

		const expanded = await card(result, { op: "list" }, true);
		expect(expanded.some(l => l.includes("more peers"))).toBe(false);
		expect(expanded.some(l => l.includes("Agent_12"))).toBe(true);
	});
});

describe("the irc card's body truncation", () => {
	it("collapses long bodies with an elision counter and expands on demand", async () => {
		const body = Array.from({ length: 6 }, (_, i) => `reply line ${i + 1}`).join("\n");
		const details: IrcDetails = { op: "wait", from: "Main", waited: msg({ body }) };
		const result: IrcViewResult = { content: [{ type: "text", text: "" }], details };

		const collapsed = await card(result, { op: "wait" });
		expect(collapsed.some(line => line.includes("reply line 2"))).toBe(true);
		expect(collapsed.some(line => line.includes("reply line 3"))).toBe(false);
		expect(collapsed.some(line => line.includes("… 4 more lines"))).toBe(true);

		const expanded = await card(result, { op: "wait" }, true);
		expect(expanded.some(line => line.includes("reply line 6"))).toBe(true);
		expect(expanded.some(line => line.includes("more lines"))).toBe(false);
	});
});
