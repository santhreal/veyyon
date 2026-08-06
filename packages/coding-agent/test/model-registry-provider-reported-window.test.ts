import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

/**
 * WHY: an agent gateway adds models faster than the bundled catalog is
 * regenerated, and discovery has no window field to read, so it substitutes
 * `AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW`. That guess is the denominator of the
 * context gauge and of the compaction threshold, so a model whose real window
 * is much larger reads as full and asks to compact on every turn.
 *
 * The provider states the real window on the wire. Once it does, that value
 * outranks the guess for every reader of `model.contextWindow`, and a later
 * reload must not put the guess back: reloads happen on their own schedule
 * (config mtime, background discovery), so a correction that did not survive
 * one would revert mid-session for no reason the user could see.
 */
describe("ModelRegistry provider-reported context window", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in this test"));

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-reported-window-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: offlineFetch });
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function anyModel() {
		const model = registry.getAll()[0];
		if (!model) throw new Error("registry loaded no models");
		return model;
	}

	test("a reported window replaces the catalogued one", () => {
		const { provider, id, contextWindow } = anyModel();
		const reported = (contextWindow ?? 0) + 777_000;

		expect(registry.recordProviderReportedContextWindow(provider, id, reported)).toBe(true);

		const updated = registry.getAll().find(m => m.provider === provider && m.id === id);
		expect(updated?.contextWindow).toBe(reported);
	});

	test("only the reported model changes", () => {
		const target = anyModel();
		const other = registry.getAll().find(m => m.provider !== target.provider || m.id !== target.id);
		if (!other) throw new Error("need a second model");
		const otherWindowBefore = other.contextWindow;

		registry.recordProviderReportedContextWindow(target.provider, target.id, 999_000);

		const otherAfter = registry.getAll().find(m => m.provider === other.provider && m.id === other.id);
		expect(otherAfter?.contextWindow).toBe(otherWindowBefore);
	});

	test("the correction survives a reload that would restore the catalogued guess", async () => {
		const { provider, id } = anyModel();
		registry.recordProviderReportedContextWindow(provider, id, 999_000);

		// A bare refresh() rebuilds nothing when the models config has not
		// changed, so it would prove nothing. Registering a provider resets the
		// mtime guard and forces the full static rebuild from the catalog, which
		// is exactly the pass that must not put the guessed window back.
		registry.registerProvider("reported-window-probe", { baseUrl: "https://probe.example.com/v1" }, "ext://probe");
		await registry.refresh("online");

		const afterReload = registry.getAll().find(m => m.provider === provider && m.id === id);
		expect(afterReload?.contextWindow).toBe(999_000);
	});

	test("re-reporting the same window is not a change", () => {
		const { provider, id } = anyModel();
		expect(registry.recordProviderReportedContextWindow(provider, id, 999_000)).toBe(true);
		expect(registry.recordProviderReportedContextWindow(provider, id, 999_000)).toBe(false);
	});

	test("a nonsense window is refused rather than adopted", () => {
		const { provider, id, contextWindow } = anyModel();

		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(registry.recordProviderReportedContextWindow(provider, id, bad)).toBe(false);
		}

		const unchanged = registry.getAll().find(m => m.provider === provider && m.id === id);
		expect(unchanged?.contextWindow).toBe(contextWindow);
	});
});
