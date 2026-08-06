/**
 * WHY: the session gate for server-side compaction is spelled
 * `settings.get("compaction.remote") !== true` (`agent-session.ts`), which is a
 * strict identity test against `true`. That spelling only means "on by default"
 * if an UNSET key resolves to the declared default rather than to `undefined`.
 * If `get` ever answered a registered-but-unwritten path with `undefined`, the
 * gate would read `undefined !== true`, return early, and server-side
 * compaction would be silently off for every operator who never touched the
 * setting. Nothing would fail: sessions would just quietly pay for a local
 * summary of a span OpenAI would have compacted for free.
 *
 * That is the whole contract this suite defends, end to end through the real
 * `Settings` and a real config file on disk: unset means on, an explicit
 * `false` is the only thing that turns it off, and an explicit `true` is a
 * no-op that agrees with the default.
 *
 * The gate expression is duplicated here on purpose. Importing `AgentSession`
 * to reach a `#private` method would drag a model registry and a transport into
 * a config test; restating the one-line predicate keeps the test pure while
 * still failing if the DEFAULT or the resolution behaviour moves. The gate's
 * own wiring is covered where it lives.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../src/config/settings";

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

/** The predicate `#tryServerSideCompaction` uses to decide whether to bail out. */
function serverCompactionRunsFor(settings: Settings): boolean {
	return settings.get("compaction.remote") === true;
}

async function agentDirWith(config: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-remote-compaction-"));
	await fs.writeFile(path.join(dir, "config.yml"), config, "utf8");
	return dir;
}

describe("an operator who never touched the setting", () => {
	it("gets server-side compaction, because unset resolves to the declared default", async () => {
		const dir = await agentDirWith("theme:\n  dark: dracula\n");
		const settings = await Settings.init({ agentDir: dir });

		expect(settings.get("compaction.remote")).toBe(true);
		expect(serverCompactionRunsFor(settings)).toBe(true);
	});

	it("gets it with no config file at all", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-remote-compaction-empty-"));
		const settings = await Settings.init({ agentDir: dir });

		expect(serverCompactionRunsFor(settings)).toBe(true);
	});
});

describe("an operator who wrote the setting down", () => {
	it("turns it off with an explicit false, which is the only thing that does", async () => {
		const dir = await agentDirWith("compaction:\n  remote: false\n");
		const settings = await Settings.init({ agentDir: dir });

		expect(serverCompactionRunsFor(settings)).toBe(false);
	});

	it("changes nothing by writing the default down explicitly", async () => {
		const dir = await agentDirWith("compaction:\n  remote: true\n");
		const settings = await Settings.init({ agentDir: dir });

		expect(serverCompactionRunsFor(settings)).toBe(true);
	});

	it("takes effect within the session when it is flipped at runtime", async () => {
		const dir = await agentDirWith("theme:\n  dark: dracula\n");
		const settings = await Settings.init({ agentDir: dir });

		expect(serverCompactionRunsFor(settings)).toBe(true);

		settings.set("compaction.remote", false);

		expect(serverCompactionRunsFor(settings)).toBe(false);
	});
});
