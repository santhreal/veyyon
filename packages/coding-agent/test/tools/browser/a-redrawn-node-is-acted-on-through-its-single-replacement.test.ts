/**
 * WHY: an action on an id or ref handle whose node a re-render replaced failed with puppeteer's
 * detached-node errors. `withRelocation` retries such an action on the single element with the same
 * role and accessible name. The retry is correct only inside narrow bounds: it runs for a node that
 * left a document that still exists and for nothing else, it acts on each replacement once, it stops
 * after `RELOCATION_ATTEMPTS`, it releases every handle it resolved and none it was given, and when it
 * gives up it reports the cause of the last failure.
 *
 * The class this closes: every branch of that retry, driven against handles whose connectedness and
 * action outcome the test sets, without a browser, so each bound holds on every run rather than on the
 * runs where a real page's redraw lands between two round trips. Every puppeteer message the retry
 * claims to recognize is swept in both directions: relocated when the node left, kept when it did not.
 * `ariaSelectorFor` is pinned on every quoting branch, because a selector that mis-quotes a name
 * matches no element and turns every relocation into a stale error.
 *
 * Not caught: whether a real `aria/` query finds the replacement, and whether the actions reach the
 * replacement's box; `an-element-the-page-redraws-still-takes-the-action.test.ts` drives those in
 * Chromium. A puppeteer release that rewords its detached-node messages passes here and fails there.
 */
import { describe, expect, it } from "bun:test";
import type { ElementHandle } from "puppeteer-core";
import { ToolError } from "../../../src/tools/core/tool-errors";
import {
	ariaSelectorFor,
	DETACHED_NODE_MESSAGE,
	type HandleRelocation,
	RELOCATION_ATTEMPTS,
	withRelocation,
} from "../../../src/tools/web/browser/element-identity";

/** The messages puppeteer raises for an action on a node that left the document. */
const PUPPETEER_DETACHED_MESSAGES = [
	DETACHED_NODE_MESSAGE,
	"Node is either not clickable or not an Element",
	"Node is either not visible or not an HTMLElement",
];

/** One DOM node as `withRelocation` reaches it. */
interface FakeNode {
	/** Whether the node is in its document; null when the document is gone and evaluation fails. */
	readonly connected: boolean | null;
	/** What an action on the node does: the result it returns, or the error it throws. */
	readonly outcome: string | Error;
	actions: number;
	disposals: number;
}

const nodeOf = new WeakMap<ElementHandle, FakeNode>();

function fakeNode(connected: boolean | null, outcome: string | Error): FakeNode {
	return { connected, outcome, actions: 0, disposals: 0 };
}

function handleFor(node: FakeNode): ElementHandle {
	const handle = {
		evaluate: async (probe: (el: { isConnected: boolean }) => unknown) => {
			if (node.connected === null) throw new Error("Execution context was destroyed.");
			return probe({ isConnected: node.connected });
		},
		dispose: async () => {
			node.disposals += 1;
		},
	} as unknown as ElementHandle;
	nodeOf.set(handle, node);
	return handle;
}

async function act(target: ElementHandle): Promise<string> {
	const node = nodeOf.get(target);
	if (!node) throw new Error("act reached a handle the test did not create");
	node.actions += 1;
	if (node.outcome instanceof Error) throw node.outcome;
	return node.outcome;
}

interface Relocator {
	readonly relocation: HandleRelocation;
	relocations: number;
	readonly staleCauses: string[];
}

/** A relocation that resolves `replacements` in order, then nothing. */
function relocatorTo(replacements: readonly FakeNode[]): Relocator {
	const relocator: Relocator = {
		relocations: 0,
		staleCauses: [],
		relocation: {
			relocate: async () => {
				const next = replacements[relocator.relocations];
				relocator.relocations += 1;
				return next ? handleFor(next) : null;
			},
			stale: cause => {
				relocator.staleCauses.push(cause);
				return new ToolError(`stale: ${cause}`);
			},
		},
	};
	return relocator;
}

describe("ariaSelectorFor quotes the name with a character it does not hold", () => {
	it.each([
		["a plain name", "Save", 'aria/[name="Save"][role="button"]'],
		["a name holding an apostrophe", "Don't save", `aria/[name="Don't save"][role="button"]`],
		["a name holding a double quote", 'Say "hi"', `aria/[name='Say "hi"'][role="button"]`],
		["a name holding both quotes", `Say "don't"`, null],
	])("%s", (_case, name, selector) => {
		expect(ariaSelectorFor({ role: "button", name })).toBe(selector);
	});
});

describe("withRelocation acts on the replacement only when the node left a document that still exists", () => {
	it("acts on the node it was given when that succeeds, and resolves and releases nothing", async () => {
		const original = fakeNode(true, "original");
		const relocator = relocatorTo([fakeNode(true, "replacement")]);

		expect(await withRelocation(handleFor(original), relocator.relocation, act)).toBe("original");
		expect(relocator.relocations).toBe(0);
		expect(original).toMatchObject({ actions: 1, disposals: 0 });
	});

	it("keeps an error that is not a detached-node message, even from a disconnected node", async () => {
		const failure = new Error("Waiting for selector `button` failed: Timeout 30000ms exceeded");
		const relocator = relocatorTo([fakeNode(true, "replacement")]);

		await expect(withRelocation(handleFor(fakeNode(false, failure)), relocator.relocation, act)).rejects.toBe(
			failure,
		);
		expect(relocator.relocations).toBe(0);
	});

	it.each(PUPPETEER_DETACHED_MESSAGES)("keeps %p from a node still in its document", async message => {
		const failure = new Error(message);
		const relocator = relocatorTo([fakeNode(true, "replacement")]);

		await expect(withRelocation(handleFor(fakeNode(true, failure)), relocator.relocation, act)).rejects.toBe(failure);
		expect(relocator.relocations).toBe(0);
	});

	it.each(PUPPETEER_DETACHED_MESSAGES)("keeps %p from a node whose document is gone", async message => {
		const failure = new Error(message);
		const relocator = relocatorTo([fakeNode(true, "replacement")]);

		await expect(withRelocation(handleFor(fakeNode(null, failure)), relocator.relocation, act)).rejects.toBe(failure);
		expect(relocator.relocations).toBe(0);
	});

	it.each(PUPPETEER_DETACHED_MESSAGES)(
		"acts once on the replacement after %p from a node that left",
		async message => {
			const original = fakeNode(false, new Error(`Protocol error: ${message}`));
			const replacement = fakeNode(true, "replacement");
			const relocator = relocatorTo([replacement]);

			expect(await withRelocation(handleFor(original), relocator.relocation, act)).toBe("replacement");
			expect(relocator.relocations).toBe(1);
			expect(replacement).toMatchObject({ actions: 1, disposals: 1 });
			expect(original.disposals).toBe(0);
		},
	);
});

describe("withRelocation gives up within its bound and names the last cause", () => {
	it("is stale with the original cause when no single element replaced the node", async () => {
		const relocator = relocatorTo([]);

		await expect(
			withRelocation(handleFor(fakeNode(false, new Error(DETACHED_NODE_MESSAGE))), relocator.relocation, act),
		).rejects.toBeInstanceOf(ToolError);
		expect(relocator.relocations).toBe(1);
		expect(relocator.staleCauses).toEqual([DETACHED_NODE_MESSAGE]);
	});

	it(`stops after ${RELOCATION_ATTEMPTS} replacements that each left too, releasing every one`, async () => {
		const replacements = Array.from({ length: RELOCATION_ATTEMPTS + 2 }, (_, index) =>
			fakeNode(false, new Error(`${DETACHED_NODE_MESSAGE} (replacement ${index})`)),
		);
		const relocator = relocatorTo(replacements);

		await expect(
			withRelocation(handleFor(fakeNode(false, new Error(DETACHED_NODE_MESSAGE))), relocator.relocation, act),
		).rejects.toBeInstanceOf(ToolError);
		expect(relocator.relocations).toBe(RELOCATION_ATTEMPTS);
		expect(replacements.map(node => [node.actions, node.disposals])).toEqual(
			replacements.map((_, index) => (index < RELOCATION_ATTEMPTS ? [1, 1] : [0, 0])),
		);
		expect(relocator.staleCauses).toEqual([`${DETACHED_NODE_MESSAGE} (replacement ${RELOCATION_ATTEMPTS - 1})`]);
	});

	it("returns the result of a later replacement after an earlier one left", async () => {
		const first = fakeNode(false, new Error(DETACHED_NODE_MESSAGE));
		const second = fakeNode(true, "second");
		const relocator = relocatorTo([first, second]);

		expect(
			await withRelocation(handleFor(fakeNode(false, new Error(DETACHED_NODE_MESSAGE))), relocator.relocation, act),
		).toBe("second");
		expect(relocator.relocations).toBe(2);
		expect([first.disposals, second.disposals]).toEqual([1, 1]);
		expect(relocator.staleCauses).toEqual([]);
	});

	it("keeps an error a replacement raises for another reason, and still releases the replacement", async () => {
		const failure = new Error("Waiting for selector `button` failed: Timeout 30000ms exceeded");
		const replacement = fakeNode(true, failure);
		const relocator = relocatorTo([replacement, fakeNode(true, "never reached")]);

		await expect(
			withRelocation(handleFor(fakeNode(false, new Error(DETACHED_NODE_MESSAGE))), relocator.relocation, act),
		).rejects.toBe(failure);
		expect(relocator.relocations).toBe(1);
		expect(replacement.disposals).toBe(1);
		expect(relocator.staleCauses).toEqual([]);
	});
});
