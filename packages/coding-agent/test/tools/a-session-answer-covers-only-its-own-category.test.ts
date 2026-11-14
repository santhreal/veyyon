/**
 * A "for session" answer at a permission prompt covers only the category it was given in.
 *
 * WHY THIS SUITE EXISTS. A prompt is raised about one of several things: the tool's tier
 * (`command`, `edit`, `read`), a destructive call, a path outside the working directory, or a
 * stored secret the arguments spend. Before categories, every card offered the same four rows, and
 * "Approve for session" on a card raised about a credential or a destructive command either
 * recorded a tool-wide grant nobody meant to give or silently recorded nothing while saying it would.
 *
 * THE CLASS THIS CLOSES. For every category in `APPROVAL_CATEGORIES`, swept at run time:
 *   - the card states that category;
 *   - it offers a session row exactly when the category remembers anything (pinned by equality);
 *   - the session answer retires a repeat of the same call and nothing outside its grant class:
 *     a tool grant never covers a secret, a secret grant never covers the tool, and neither ever
 *     covers a destructive or outside-the-directory call;
 *   - the session refusal refuses a repeat of the same call without a card.
 * A new category without a fixture fails the sweep before any case runs.
 *
 * `secrets.askBeforeUse` is pinned here too, because it removes one category from the gate: off,
 * a call that only spends a secret runs unasked, and a call that also leaves the working directory
 * is still asked about the path alone.
 *
 * WHAT IT DOES NOT CATCH. The wording of a reason, and what a host draws from the card.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { ApprovalCard } from "@veyyon/coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { APPROVAL_CATEGORIES, type ApprovalCategory } from "@veyyon/coding-agent/tools/core/approval-gate";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import { type } from "arktype";

const TOKEN = "ghp_categorysweepcredential1234567890";
const OTHER_TOKEN = "ghp_secondsweepcredential0987654321";
const UNNAMED_TOKEN = "ghp_unnamedsweepcredential111122223333";

const RAN = "the tool ran";
const CWD = "/repo-under-test";

interface CallArgs {
	critical?: boolean;
	target?: string;
	content?: string;
	tier?: "read" | "write" | "exec";
}

/** One `bash` whose arguments select its tier, its destructive flag, its path and its content. */
const TOOL = {
	name: "bash",
	label: "bash",
	summary: "records that it ran",
	description: "records that it ran",
	parameters: type({ "critical?": "boolean", "target?": "string", "content?": "string", "tier?": "string" }),
	approval: (args: CallArgs) => ({
		tier: args?.tier ?? "exec",
		critical: args?.critical === true,
		...(args?.critical ? { reason: "Deletes files." } : {}),
	}),
	filesystemTargets: (args: CallArgs) => (typeof args?.target === "string" ? [args.target] : []),
	execute: async () => ({ content: [{ type: "text", text: RAN }] }),
} as unknown as AgentTool;

/** A call raising exactly one concern of each category, in the rung that raises it. */
interface Fixture {
	mode: string;
	params: CallArgs;
}

const FIXTURES: Record<ApprovalCategory, Fixture> = {
	destructive: { mode: "auto", params: { critical: true } },
	secret: { mode: "auto", params: { content: `token=${TOKEN}` } },
	outside: { mode: "auto", params: { target: "/elsewhere/notes.txt" } },
	command: { mode: "ask", params: { tier: "exec" } },
	edit: { mode: "ask", params: { tier: "write" } },
	read: { mode: "ask", params: { tier: "read" } },
};

/**
 * Which standing answers a category's session row records: the tool name, the secret names, or
 * nothing. Two categories in one class share a grant; categories in different classes never do.
 */
const GRANT_CLASS: Record<ApprovalCategory, "tool" | "secret" | undefined> = {
	destructive: undefined,
	secret: "secret",
	outside: undefined,
	command: "tool",
	edit: "tool",
	read: "tool",
};

function makeStore(): SessionToolApprovals & { keys(): string[] } {
	const map = new Map<string, "allow" | "deny">();
	return {
		get: key => map.get(key),
		set: (key, decision) => {
			map.set(key, decision);
		},
		keys: () => [...map.keys()],
	};
}

interface Outcome {
	ran: boolean;
	error: string | undefined;
	/** The card each prompt was drawn from. */
	cards: ApprovalCard[];
}

/** Run one call, answering every prompt with the row `pick` selects from the card. */
async function run(
	fixture: Fixture,
	store: SessionToolApprovals,
	pick: (card: ApprovalCard) => string | undefined,
	settings: Record<string, unknown> = {},
): Promise<Outcome> {
	const cards: ApprovalCard[] = [];
	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({
			select: async (_body: string, _items: unknown[], options: { approval: ApprovalCard }) => {
				cards.push(options.approval);
				return pick(options.approval);
			},
		}),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	} as unknown as ExtensionRunner;
	const values: Record<string, unknown> = { "tools.approvalMode": fixture.mode, "tools.approval": {}, ...settings };
	const context = {
		settings: { get: (key: string) => values[key] },
		sessionApprovals: store,
		sessionManager: { getCwd: () => CWD, getSessionId: () => "session-under-test" },
		obfuscateProviderText: (text: string) =>
			text
				.replaceAll(TOKEN, "#DEPLOY_TOKEN#")
				.replaceAll(OTHER_TOKEN, "#OTHER_TOKEN#")
				.replaceAll(UNNAMED_TOKEN, "#0AB12CD34EF56AB78CD90EF1#"),
	};
	try {
		const result = await new ExtensionToolWrapper(TOOL, runner).execute(
			"call",
			fixture.params as never,
			undefined,
			undefined,
			context as never,
		);
		const first = result.content[0];
		return { ran: first?.type === "text" && first.text === RAN, error: undefined, cards };
	} catch (err) {
		return { ran: false, error: err instanceof Error ? err.message : String(err), cards };
	}
}

const labelOf = (id: string) => (card: ApprovalCard) => card.choices.find(choice => choice.id === id)?.label;

describe("every approval category has a fixture", () => {
	it("covers exactly the categories the gate defines", () => {
		expect(Object.keys(FIXTURES).sort()).toEqual([...APPROVAL_CATEGORIES].sort());
	});
});

describe.each([...APPROVAL_CATEGORIES])("a %s prompt", category => {
	const fixture = FIXTURES[category];

	it("states its category on the card", async () => {
		const outcome = await run(fixture, makeStore(), labelOf("once"));

		expect(outcome.cards.map(card => card.category)).toEqual([category]);
		expect(outcome.ran).toBe(true);
	});

	it("records under its own grant class and nowhere else", async () => {
		const store = makeStore();
		const first = await run(fixture, store, labelOf("session"));
		const remembers = GRANT_CLASS[category] !== undefined;

		// A row that would record nothing is not offered; answering a missing row refuses.
		expect(first.ran).toBe(remembers);
		expect(store.keys().length > 0).toBe(remembers);
		if (!remembers) return;

		const repeat = await run(fixture, store, labelOf("once"));
		expect(repeat.cards).toEqual([]);
		expect(repeat.ran).toBe(true);

		for (const other of APPROVAL_CATEGORIES) {
			const shared = GRANT_CLASS[other] === GRANT_CLASS[category];
			const later = await run(FIXTURES[other], store, labelOf("once"));
			expect(later.cards.length, `${category} grant against a ${other} call`).toBe(shared ? 0 : 1);
			expect(later.ran).toBe(true);
		}
	});

	it("refuses a repeat without a card once refused for the session", async () => {
		const store = makeStore();
		const first = await run(fixture, store, labelOf("never"));
		if (GRANT_CLASS[category] === undefined) {
			expect(first.cards[0]?.choices.map(choice => choice.id)).toEqual(["once", "deny"]);
			return;
		}

		expect(first.error).toBeDefined();
		const repeat = await run(fixture, store, labelOf("once"));
		expect(repeat.cards).toEqual([]);
		expect(repeat.error).toMatch(/^Tool call denied for this session: bash/);
	});
});

describe("the categories that offer a session row", () => {
	it("are the tier categories and the secret", async () => {
		const remembering: ApprovalCategory[] = [];
		for (const category of APPROVAL_CATEGORIES) {
			const outcome = await run(FIXTURES[category], makeStore(), labelOf("once"));
			if (outcome.cards[0]?.choices.some(choice => choice.id === "session")) remembering.push(category);
		}
		expect(remembering).toEqual(["secret", "command", "edit", "read"]);
	});
});

describe("a secret grant", () => {
	it("covers a later call only when every secret it spends was granted", async () => {
		const store = makeStore();
		await run(FIXTURES.secret, store, labelOf("session"));

		const both = { mode: "auto", params: { content: `${TOKEN} ${OTHER_TOKEN}` } };
		const outcome = await run(both, store, labelOf("once"));

		expect(outcome.cards.map(card => card.choices.find(choice => choice.id === "session")?.scope)).toEqual([
			"DEPLOY_TOKEN, OTHER_TOKEN",
		]);
	});

	it("is never offered, and never assumed, for a secret with no name", async () => {
		const store = makeStore();
		const unnamed = { mode: "auto", params: { content: `token=${UNNAMED_TOKEN}` } };
		const first = await run(unnamed, store, labelOf("once"));
		const repeat = await run(unnamed, store, labelOf("once"));

		expect(first.cards.map(card => card.choices.map(choice => choice.id))).toEqual([["once", "deny"]]);
		expect(repeat.cards).toHaveLength(1);
		expect(store.keys()).toEqual([]);
	});

	it("does not cover a call that also spends a secret with no name", async () => {
		const store = makeStore();
		await run(FIXTURES.secret, store, labelOf("session"));

		const mixed = { mode: "auto", params: { content: `${TOKEN} ${UNNAMED_TOKEN}` } };
		const outcome = await run(mixed, store, labelOf("once"));

		expect(outcome.cards.map(card => card.choices.map(choice => choice.id))).toEqual([["once", "deny"]]);
	});
});

describe("a call raising several concerns", () => {
	it("is led by the highest-ranked one and offers only what that one can remember", async () => {
		const call = { mode: "auto", params: { critical: true, content: `token=${TOKEN}`, target: "/elsewhere/a" } };
		const outcome = await run(call, makeStore(), labelOf("once"));

		expect(outcome.cards.map(card => card.category)).toEqual(["destructive"]);
		expect(outcome.cards[0]?.reasons.map(reason => reason.category)).toEqual(["destructive", "secret", "outside"]);
		expect(outcome.cards[0]?.choices.map(choice => choice.id)).toEqual(["once", "deny"]);
	});
});

describe("secrets.askBeforeUse", () => {
	const spends = FIXTURES.secret;

	it.each([
		["absent", {}],
		["true", { "secrets.askBeforeUse": true }],
	])("asks before a secret is spent when %s", async (_name, settings) => {
		const outcome = await run(spends, makeStore(), labelOf("once"), settings);

		expect(outcome.cards.map(card => card.category)).toEqual(["secret"]);
	});

	it("spends the secret unasked when false", async () => {
		const outcome = await run(spends, makeStore(), labelOf("deny"), { "secrets.askBeforeUse": false });

		expect(outcome.cards).toEqual([]);
		expect(outcome.ran).toBe(true);
	});

	it("still asks about every other concern when false", async () => {
		const both = { mode: "auto", params: { content: `token=${TOKEN}`, target: "/elsewhere/notes.txt" } };
		const outcome = await run(both, makeStore(), labelOf("once"), { "secrets.askBeforeUse": false });

		expect(outcome.cards.map(card => card.reasons.map(reason => reason.category))).toEqual([["outside"]]);
	});

	it("never asks under yolo, whatever its value", async () => {
		const outcome = await run({ ...spends, mode: "yolo" }, makeStore(), labelOf("deny"), {
			"secrets.askBeforeUse": true,
		});

		expect(outcome.cards).toEqual([]);
		expect(outcome.ran).toBe(true);
	});
});
