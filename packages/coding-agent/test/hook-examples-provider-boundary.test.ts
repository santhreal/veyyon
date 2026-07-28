import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Context, Model, StreamOptions } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import customCompaction from "../examples/hooks/custom-compaction";
import handoff from "../examples/hooks/handoff";
import qna from "../examples/hooks/qna";

const model = { provider: "test", id: "hook-model" } as Model;

function customUi(notifications: string[], setEditorText: (text: string) => void = () => {}) {
	return {
		notify: (message: string) => notifications.push(message),
		setEditorText,
		editor: async (_prompt: string, initial: string) => initial,
		custom: async <T>(render: (tui: unknown, theme: unknown, done: (value: T) => void) => { dispose?: () => void }) =>
			await new Promise<T>(resolve => {
				let component: { dispose?: () => void } | undefined;
				component = render(
					{ requestComponentRender: () => {}, requestDirectWrite: () => {} },
					{ fg: (_role: string, text: string) => text },
					value => {
						component?.dispose?.();
						resolve(value);
					},
				);
			}),
	};
}

function providerContext(marker: string, replacement: string, notifications: string[]) {
	let activeReplacement = marker;
	return {
		get activeReplacement() {
			return activeReplacement;
		},
		context: {
			hasUI: true,
			model,
			modelRegistry: {
				getApiKey: async () => {
					// Credential resolution installs the runtime used by the physical attempt.
					activeReplacement = replacement;
					return "test-key";
				},
			},
			obfuscateProviderText: (text: string) => text.replaceAll(marker, activeReplacement),
			ui: customUi(notifications),
		},
	};
}

function captureComplete(captures: string[], responseText = "safe result") {
	return spyOn(ai, "complete").mockImplementation(async (_model: Model, context: Context, options?: StreamOptions) => {
		const payload = options?.onPayload?.({ context, nested: context });
		captures.push(JSON.stringify(payload));
		return {
			stopReason: "stop",
			content: [{ type: "text", text: responseText }],
		} as never;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("published online hook examples", () => {
	it("uses the post-credential runtime and final onPayload walk in compaction, qna, and handoff", async () => {
		// The distinctive marker is deliberately long so accidental fragment-only assertions cannot
		// pass. Each hook retains it raw until getApiKey resolves, then the context builder and final
		// recursive payload transform expose only the runtime's current placeholder.
		const marker = `HOOK_EXAMPLE_BOUNDARY_START_${"S".repeat(180)}_HOOK_EXAMPLE_BOUNDARY_END`;

		const compactionCaptures: string[] = [];
		const compactionNotices: string[] = [];
		captureComplete(compactionCaptures, "safe summary");
		let compactHandler: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
		customCompaction({ on: (_name: string, handler: typeof compactHandler) => (compactHandler = handler) } as never);
		const compactionRuntime = providerContext(marker, "#COMPACTION_CURRENT#", compactionNotices);
		const compactionResult = await compactHandler?.(
			{
				preparation: {
					messagesToSummarize: [{ role: "user", content: [{ type: "text", text: marker }], timestamp: 1 }],
					turnPrefixMessages: [],
					tokensBefore: 100,
					firstKeptEntryId: "entry-1",
					previousSummary: marker,
				},
				branchEntries: [],
				signal: new AbortController().signal,
			},
			compactionRuntime.context,
		);
		expect(compactionResult).toMatchObject({ compaction: { summary: "safe summary" } });

		vi.restoreAllMocks();
		const qnaCaptures: string[] = [];
		captureComplete(qnaCaptures, "Q: Safe?\nA:");
		let qnaHandler: ((args: string, context: unknown) => Promise<void>) | undefined;
		qna({
			registerCommand: (_name: string, definition: { handler: typeof qnaHandler }) =>
				(qnaHandler = definition.handler),
		} as never);
		const qnaNotices: string[] = [];
		let qnaEditor = "";
		const qnaRuntime = providerContext(marker, "#QNA_CURRENT#", qnaNotices);
		qnaRuntime.context.ui = customUi(qnaNotices, text => (qnaEditor = text)) as never;
		await qnaHandler?.("", {
			...qnaRuntime.context,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: marker }] },
					},
				],
			},
		});
		expect(qnaEditor).toContain("Q: Safe?");

		vi.restoreAllMocks();
		const handoffCaptures: string[] = [];
		captureComplete(handoffCaptures, "safe handoff");
		let handoffHandler: ((args: string, context: unknown) => Promise<void>) | undefined;
		handoff({
			registerCommand: (_name: string, definition: { handler: typeof handoffHandler }) =>
				(handoffHandler = definition.handler),
		} as never);
		const handoffNotices: string[] = [];
		let handoffEditor = "";
		const handoffRuntime = providerContext(marker, "#HANDOFF_CURRENT#", handoffNotices);
		handoffRuntime.context.ui = customUi(handoffNotices, text => (handoffEditor = text)) as never;
		await handoffHandler?.(marker, {
			...handoffRuntime.context,
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: marker }], timestamp: 1 } },
				],
				getSessionFile: () => "/session.jsonl",
			},
			newSession: async () => ({ cancelled: false }),
		});
		expect(handoffEditor).toBe("safe handoff");

		for (const [capture, placeholder] of [
			[compactionCaptures[0], "#COMPACTION_CURRENT#"],
			[qnaCaptures[0], "#QNA_CURRENT#"],
			[handoffCaptures[0], "#HANDOFF_CURRENT#"],
		] as const) {
			expect(capture).toContain(placeholder);
			expect(capture).not.toContain(marker);
			expect(capture).not.toContain("HOOK_EXAMPLE_BOUNDARY_START");
			expect(capture).not.toContain("HOOK_EXAMPLE_BOUNDARY_END");
		}
	});

	it("does not copy provider error text into compaction notifications", async () => {
		const marker = "HOOK_PROVIDER_ERROR_SECRET_7812";
		const notifications: string[] = [];
		spyOn(ai, "complete").mockRejectedValue(new Error(marker));
		let handler: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
		customCompaction({ on: (_name: string, next: typeof handler) => (handler = next) } as never);
		const runtime = providerContext(marker, "#ERROR_CURRENT#", notifications);

		await handler?.(
			{
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					tokensBefore: 0,
					firstKeptEntryId: "entry",
					previousSummary: marker,
				},
				branchEntries: [],
				signal: new AbortController().signal,
			},
			runtime.context,
		);

		expect(notifications).toContain("Compaction request failed, using default compaction");
		expect(JSON.stringify(notifications)).not.toContain(marker);
	});
});
