/**
 * WHY:
 *
 * The terminal offers two ways to reach the same model list. `/model` picks the
 * model and writes it as the default role, so the next session starts on it.
 * `/switch` (alt+p) tries a model for the session in front of the operator and
 * leaves the configuration alone. The desktop had one of them: every row of the
 * model picker wrote the default role, so trying a model on one session
 * silently repointed every session after it, and the command the terminal
 * spells `/switch` had no desktop answer at all.
 *
 * The class this closes: a desktop control that writes the operator's
 * configuration when the command it stands for does not, or the reverse.
 *
 * This suite defends:
 * 1. `SelectModel` with `persist: false` runs the session on the chosen model
 *    and leaves `modelRoles.default` as the operator wrote it, proven by a
 *    second host process reading the same directory.
 * 2. `SelectModel` with `persist: true` writes the chosen model as the default
 *    role, proven the same way.
 * 3. A payload that omits `persist` writes the default role, which is the
 *    spelling every caller before this field used.
 *
 * What it does NOT catch: which row of the desktop picker sends which flag
 * (`crates/veyyon-desktop-surface` owns that, and a Rust suite pins it), and
 * the thinking level a role carries with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthStorage } from "@veyyon/ai";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ModelsView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

const PROVIDER = "anthropic";
const CONFIGURED = "claude-opus-4-8";
const TRIED = "claude-sonnet-4-5";
/** How long a background settings save may take before the suite calls it hung. */
const SAVE_DEADLINE_MS = 5_000;

describe("a model tried for one session", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient | null = null;
	let authStorage: AuthStorage;

	/** Opens a host on the test directory, with the settings singleton cleared. */
	async function startHost(): Promise<TestSocketClient> {
		resetSettingsForTest();
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		return client;
	}

	async function closeHost(): Promise<void> {
		client?.destroy();
		client = null;
		await server?.close();
		server = null;
	}

	/** The model the host states, which is the model the next turn runs on. */
	async function statedModel(request: number, connected: TestSocketClient): Promise<string> {
		const { frames, outcome } = await connected.request(request, "RefreshModels");
		expect(outcome).toEqual({ RequestSucceeded: { request } });
		const view = snapshotSections<ModelsView>(frames, "Models")[0];
		return view.current ? `${view.current.provider}/${view.current.id}` : "none";
	}

	/** The default role on disk, which is what outlives the process. */
	async function persistedDefault(): Promise<string | null> {
		const text = await fs.readFile(path.join(tempDir, "config.yml"), "utf8");
		return /^\s+default:\s*(\S+)$/m.exec(text)?.[1] ?? null;
	}

	/**
	 * Waits for the background save to land, and fails on the deadline rather
	 * than on a value, so a save that never happens reads as a timeout instead
	 * of a wrong model.
	 */
	async function awaitPersisted(expected: string): Promise<void> {
		const deadline = Date.now() + SAVE_DEADLINE_MS;
		while (Date.now() < deadline) {
			if ((await persistedDefault()) === expected) return;
			await sleep(25);
		}
		expect(await persistedDefault()).toBe(expected);
	}

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-session-model-"));
		authStorage = await isolatedAuthStorage(tempDir);
		await authStorage.set(PROVIDER, { type: "api_key", key: "sk-ant-not-a-real-key-000222" });
		await fs.writeFile(
			path.join(tempDir, "config.yml"),
			`modelRoles:\n  default: ${PROVIDER}/${CONFIGURED}\n`,
			"utf8",
		);
	});

	afterEach(async () => {
		await closeHost();
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test("runs on the model and leaves the operator's default alone", async () => {
		const first = await startHost();
		expect(await statedModel(1, first)).toBe(`${PROVIDER}/${CONFIGURED}`);

		const { outcome } = await first.request(2, {
			SelectModel: { provider: PROVIDER, model: TRIED, persist: false },
		});
		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(await statedModel(3, first)).toBe(`${PROVIDER}/${TRIED}`);
		// A save the host never makes cannot be waited for, so the disk is read
		// after the same window a real save would have used.
		await sleep(250);
		expect(await persistedDefault()).toBe(`${PROVIDER}/${CONFIGURED}`);

		await closeHost();
		const second = await startHost();
		expect(await statedModel(1, second)).toBe(`${PROVIDER}/${CONFIGURED}`);
	});

	test("choosing a model writes it as the default role", async () => {
		const first = await startHost();
		const { outcome } = await first.request(1, {
			SelectModel: { provider: PROVIDER, model: TRIED, persist: true },
		});
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });
		await awaitPersisted(`${PROVIDER}/${TRIED}`);

		await closeHost();
		const second = await startHost();
		expect(await statedModel(1, second)).toBe(`${PROVIDER}/${TRIED}`);
	});

	test("a payload without the field writes the default role", async () => {
		const first = await startHost();
		const { outcome } = await first.request(1, {
			SelectModel: { provider: PROVIDER, model: TRIED },
		});
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });
		await awaitPersisted(`${PROVIDER}/${TRIED}`);
	});
});
