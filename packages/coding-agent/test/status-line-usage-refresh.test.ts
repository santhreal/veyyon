import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { StatusLineComponent } from "../src/modes/terminal/components/status-line/component";
import { StatusPresentationProducer } from "../src/presentation/status-producer";
import { statusLineSessionParts } from "./helpers/status-line-session";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

function makeSession(fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>) {
	const session = {
		...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "test" }),
		fetchUsageReports,
	} as unknown as AgentSession;
	return new StatusPresentationProducer(session);
}

function usageReport(percent: number): unknown[] {
	return [
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5h", resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("does not invoke usage fetching synchronously on the render path", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}),
		);

		component.refreshUsageInBackground();
		expect(calls).toBe(0);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("passes a startup timeout signal to the background usage fetch", async () => {
		let signal: AbortSignal | undefined;
		// Never resolves, so the signal is still the live one the fetch is holding when the
		// startup budget runs out.
		const component = new StatusLineComponent(
			makeSession(nextSignal => {
				signal = nextSignal;
				return Promise.withResolvers<unknown>().promise;
			}),
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// A TIMEOUT signal, not merely an AbortSignal: an unarmed controller would satisfy
		// `toBeInstanceOf` and let a hung provider hold the render cadence forever, which is the
		// whole reason the fetch is handed a signal at all.
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal?.aborted).toBe(false);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(signal?.aborted).toBe(true);
	});

	it("backs off after the startup timeout when usage fetching hangs", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(() => {
				calls++;
				return Promise.withResolvers<unknown>().promise;
			}),
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("applies late usage reports that resolve after the startup timeout", async () => {
		const late = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(makeSession(() => late.promise));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(plain(component.renderQuietLine(80) ?? "")).not.toContain("5h");

		late.resolve(usageReport(42));
		await flushMicrotasks();

		expect(plain(component.renderQuietLine(80) ?? "")).toContain("5h 42%");
	});

	it("re-fetches usage immediately when the session rotates to another org under the same email", async () => {
		let calls = 0;
		let orgId = "org-team";
		const base = {
			...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "test" }),
			fetchUsageReports: async () => {
				calls++;
				return usageReport(10);
			},
			state: {
				messages: [],
				model: { contextWindow: 200_000, provider: "anthropic" },
			},
			modelRegistry: {
				authStorage: {
					getOAuthAccountIdentity: () => ({
						email: "shared@example.com",
						accountId: "account-shared",
						orgId,
					}),
				},
			},
		} as unknown as AgentSession;
		const component = new StatusLineComponent(new StatusPresentationProducer(base));

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Same org within the cache TTL: served from cache, no refetch.
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Org rotation under the same email/account must invalidate the cache.
		orgId = "org-max";
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);
	});

	it("does not allow a late response from a prior session to overwrite the new session when retargeting the same producer", async () => {
		const oldDeferred = Promise.withResolvers<unknown>();
		const newDeferred = Promise.withResolvers<unknown>();

		const oldSession = {
			...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "old-session" }),
			fetchUsageReports: () => oldDeferred.promise,
			sessionId: "session-old",
		} as unknown as AgentSession;

		const newSession = {
			...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "new-session" }),
			fetchUsageReports: () => newDeferred.promise,
			sessionId: "session-new",
		} as unknown as AgentSession;

		const producer = new StatusPresentationProducer(oldSession);
		const component = new StatusLineComponent(producer);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Switch session on the SAME producer
		producer.setSession(newSession);
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Old deferred resolves with 88%
		oldDeferred.resolve(usageReport(88));
		await flushMicrotasks();

		// New session's status line must NOT be overwritten with old session's 88%
		expect(plain(component.renderQuietLine(80) ?? "")).not.toContain("5h 88%");

		// New deferred resolves with 22%
		newDeferred.resolve(usageReport(22));
		await flushMicrotasks();

		expect(plain(component.renderQuietLine(80) ?? "")).toContain("5h 22%");
	});

	it("does not allow a post-timeout late response from a prior session to overwrite new session data", async () => {
		const oldDeferred = Promise.withResolvers<unknown>();
		const newDeferred = Promise.withResolvers<unknown>();

		const oldSession = {
			...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "old-session" }),
			fetchUsageReports: () => oldDeferred.promise,
			sessionId: "session-old",
		} as unknown as AgentSession;

		const newSession = {
			...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "new-session" }),
			fetchUsageReports: () => newDeferred.promise,
			sessionId: "session-new",
		} as unknown as AgentSession;

		const producer = new StatusPresentationProducer(oldSession);
		const component = new StatusLineComponent(producer);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Timeout the old request
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		// Switch to new session on the SAME producer
		producer.setSession(newSession);
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		// Old request resolves very late after its timeout
		oldDeferred.resolve(usageReport(95));
		await flushMicrotasks();

		expect(plain(component.renderQuietLine(80) ?? "")).not.toContain("5h 95%");

		// New request resolves
		newDeferred.resolve(usageReport(15));
		await flushMicrotasks();

		expect(plain(component.renderQuietLine(80) ?? "")).toContain("5h 15%");
	});
});
