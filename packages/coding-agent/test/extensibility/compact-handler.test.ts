import { describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import {
	runExtensionCompact,
	runExtensionSetModel,
} from "@veyyon/coding-agent/extensibility/extensions/compact-handler";
import type { ConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";

/**
 * These two adapters bridge the extension-facing API shape to AgentSession's method
 * signatures, and are shared by print-mode, rpc-mode, and the executor so the split
 * cannot drift. They were untested. runExtensionCompact must route a string argument to
 * the `instructions` positional and an object to the `options` positional (never both,
 * never swapped), and pass undefined for whichever is absent. runExtensionSetModel must
 * return false AND skip setModel when no API key exists for the model (a blank "" key
 * counts as absent), and only switch the model when a key is present. A regression would
 * pass compact instructions as options, or switch to a model the session has no key for.
 */

const model = { id: "m" } as unknown as Model;

describe("runExtensionCompact", () => {
	it("routes a string to instructions with no options", async () => {
		const calls: [unknown, unknown][] = [];
		await runExtensionCompact({ compact: async (i, o) => void calls.push([i, o]) }, "do it");
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe("do it");
		expect(calls[0]![1]).toBeUndefined();
	});

	it("routes an object to options with no instructions", async () => {
		const calls: [unknown, unknown][] = [];
		const opts = { maxTokens: 5 };
		await runExtensionCompact({ compact: async (i, o) => void calls.push([i, o]) }, opts as never);
		expect(calls[0]![0]).toBeUndefined();
		expect(calls[0]![1]).toBe(opts);
	});

	it("passes undefined for both when the argument is undefined", async () => {
		const calls: [unknown, unknown][] = [];
		await runExtensionCompact({ compact: async (i, o) => void calls.push([i, o]) }, undefined);
		expect(calls[0]![0]).toBeUndefined();
		expect(calls[0]![1]).toBeUndefined();
	});
});

describe("runExtensionSetModel", () => {
	const makeSession = (key: string | undefined) => {
		let setCount = 0;
		const temporaryCalls: Array<{
			model: Model;
			thinkingLevel: ConfiguredThinkingLevel | undefined;
			options: { ephemeral?: boolean } | undefined;
		}> = [];
		return {
			session: {
				modelRegistry: { getApiKey: async () => key },
				setModel: async () => {
					setCount += 1;
				},
				setModelTemporary: async (
					model: Model,
					thinkingLevel?: ConfiguredThinkingLevel,
					options?: { ephemeral?: boolean },
				) => {
					temporaryCalls.push({ model, thinkingLevel, options });
				},
			},
			setCount: () => setCount,
			temporaryCalls,
			temporaryCount: () => temporaryCalls.length,
		};
	};

	it("switches the model and returns true when a key exists", async () => {
		const { session, setCount } = makeSession("sk-x");
		expect(await runExtensionSetModel(session, model)).toBe(true);
		expect(setCount()).toBe(1);
	});

	it("switches through the temporary path, and only there, when the switch is ephemeral", async () => {
		const { session, setCount, temporaryCount } = makeSession("sk-x");
		expect(await runExtensionSetModel(session, model, { ephemeral: true })).toBe(true);
		expect(setCount()).toBe(0);
		expect(temporaryCount()).toBe(1);
	});

	it("returns false and does not switch when there is no key", async () => {
		const { session, setCount } = makeSession(undefined);
		expect(await runExtensionSetModel(session, model)).toBe(false);
		expect(setCount()).toBe(0);
	});

	it("treats a blank key as absent", async () => {
		const { session, setCount } = makeSession("");
		expect(await runExtensionSetModel(session, model)).toBe(false);
		expect(setCount()).toBe(0);
	});
	it.each([undefined, "", "sk-x"])("uses only an ephemeral switch when authorized with %p", async key => {
		const { session, setCount, temporaryCalls } = makeSession(key);
		expect(await runExtensionSetModel(session, model, { ephemeral: true })).toBe(Boolean(key));
		expect(setCount()).toBe(0);
		expect(temporaryCalls).toEqual(key ? [{ model, thinkingLevel: undefined, options: { ephemeral: true } }] : []);
	});
});
