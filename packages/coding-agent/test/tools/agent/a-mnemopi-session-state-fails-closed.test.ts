import { describe, expect, it } from "bun:test";
import type { MnemopiSessionState } from "../../../src/memory/mnemopi/state";
import { requireMnemopiSessionState } from "../../../src/tools/agent/memory-session";
import { makeToolSession } from "../../helpers/tool-session";

describe("requireMnemopiSessionState", () => {
	it("returns initialized state when session provides Mnemopi state", () => {
		const dummyState = { bank: "default" } as unknown as MnemopiSessionState;
		const session = makeToolSession({ cwd: "/tmp", hasUI: true, getMnemopiSessionState: () => dummyState });
		const state = requireMnemopiSessionState(session);
		expect(state).toBe(dummyState);
	});

	it("fails closed with an error when Mnemopi backend is not initialized", () => {
		const session = makeToolSession({ cwd: "/tmp", hasUI: true, getMnemopiSessionState: () => undefined });
		expect(() => requireMnemopiSessionState(session)).toThrow("Mnemopi backend is not initialised for this session.");
	});

	it("fails closed when getMnemopiSessionState method is absent", () => {
		const session = makeToolSession({ cwd: "/tmp", hasUI: true });
		expect(() => requireMnemopiSessionState(session)).toThrow("Mnemopi backend is not initialised for this session.");
	});
});
