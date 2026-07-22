/**
 * Model-run clock on the location line — `…keyhog  ·  main *      0:42` while
 * the agent runs, `Worked for 4m12s` once the run completes. The readout is
 * MODEL RUNTIME from the ONE active-processing meter (the same accounting
 * behind the `time_spent` segment), never wall time since launch: the first
 * shipped version anchored at TUI construction and ticked while the model had
 * not even started — the exact bug the user reported ("the model didnt even
 * start and the timer is ticking"). These tests lock the corrected contract.
 *
 * Locks:
 *  1. Before the model has EVER run: no clock, no "Worked for", nothing.
 *  2. While a run is live: a ticking colon clock of THAT run's elapsed, after
 *     the roomy 6-space gap (wider than the `  ·  ` separator).
 *  3. When the run ends: `Worked for <duration>` in compound units — and it
 *     stays frozen (idle wall time never accumulates).
 *  4. A new run restarts the ticking clock; its completion replaces the
 *     Worked-for readout with the NEW run's duration (per-run, not a total).
 *  5. Both quiet renderers carry the readout — one owner, two surfaces.
 *  6. On a tight footline the clock sheds before any capability segment.
 *  7. An empty location group never shows a bare clock.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("location line model-run clock", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let tempDir: TempDir;
	const T0 = new Date("2026-07-22T10:00:00Z");

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		setSystemTime(T0);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-session-elapsed-clock-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function locationLine(statusLine: StatusLineComponent): string | null {
		const { locationLine: line } = statusLine.renderQuietLines(120);
		return line === null ? null : stripVTControlCharacters(line).trimEnd();
	}

	function at(offsetMs: number): void {
		setSystemTime(new Date(T0.getTime() + offsetMs));
	}

	it("shows nothing before the model has ever run — no idle wall-clock ticking", () => {
		const statusLine = new StatusLineComponent(session);
		at(3_600_000);
		const line = locationLine(statusLine);
		expect(line).not.toBeNull();
		expect(line).not.toMatch(/\d:\d\d/);
		expect(line).not.toContain("Worked for");
	});

	it("ticks the current run's elapsed after the roomy gap while the agent runs", () => {
		const statusLine = new StatusLineComponent(session);
		at(10_000);
		statusLine.markActivityStart();
		at(10_000 + 95_000);
		// A non-space location character, then EXACTLY the 6-space gap, then
		// the run clock at the end of the line.
		expect(locationLine(statusLine)).toMatch(/\S {6}1:35$/);
	});

	it("freezes into 'Worked for <duration>' when the run ends", () => {
		const statusLine = new StatusLineComponent(session);
		statusLine.markActivityStart();
		at(95_000);
		statusLine.markActivityEnd();
		expect(locationLine(statusLine)).toMatch(/ {6}Worked for 1m35s$/);
		// Idle wall time never accumulates into the readout.
		at(3_600_000);
		expect(locationLine(statusLine)).toMatch(/ {6}Worked for 1m35s$/);
	});

	it("restarts per run: a new run ticks from zero and replaces the Worked-for readout", () => {
		const statusLine = new StatusLineComponent(session);
		statusLine.markActivityStart();
		at(95_000);
		statusLine.markActivityEnd();
		at(200_000);
		statusLine.markActivityStart();
		at(200_000 + 7_000);
		expect(locationLine(statusLine)).toMatch(/ {6}0:07$/);
		statusLine.markActivityEnd();
		expect(locationLine(statusLine)).toMatch(/ {6}Worked for 7\.0s$/);
	});

	it("carries the readout on the single-footline renderer too (one owner)", () => {
		const statusLine = new StatusLineComponent(session);
		statusLine.markActivityStart();
		at(95_000);
		const line = statusLine.renderQuietLine(120);
		expect(line).not.toBeNull();
		expect(stripVTControlCharacters(line as string)).toContain("      1:35");
	});

	/** Live-capture regression (2026-07-22, 100-col tmux): the clock widened
	 * the footline's left side enough that the WHOLE right group (context
	 * gauge, mode) was shed. The clock is comfort chrome and must shed FIRST —
	 * no width may exist where a capability segment is gone while the clock
	 * stays. */
	it("sheds the clock from the single footline before any capability segment", () => {
		const statusLine = new StatusLineComponent(session);
		statusLine.markActivityStart();
		const wide = statusLine.renderQuietLine(300);
		expect(wide).not.toBeNull();
		const wideStripped = stripVTControlCharacters(wide as string);
		expect(wideStripped).toContain("0:00");
		// The right group sits after the widest space run; its first part is
		// the highest-priority capability segment.
		const rightGroup = wideStripped.trimEnd().split(/ {8,}/).pop() as string;
		const firstCapability = rightGroup.split("  ·  ")[0] as string;
		expect(firstCapability.length).toBeGreaterThan(0);
		for (let width = 299; width >= 60; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const stripped = stripVTControlCharacters(line);
			if (stripped.includes("0:00")) continue;
			expect(stripped).toContain(firstCapability);
			return;
		}
		throw new Error("expected some width in [60, 299] to shed the clock");
	});

	it("never renders the clock alone when the location group is empty", () => {
		// Strip every location segment (path/git/pr) from both sides; the
		// location line must vanish entirely instead of showing a bare clock.
		// Custom preset required — any named preset overrides the segment lists.
		settings.set("statusLine.preset", "custom");
		settings.set("statusLine.leftSegments", ["model"]);
		settings.set("statusLine.rightSegments", ["context_pct"]);
		const statusLine = new StatusLineComponent(session);
		statusLine.markActivityStart();
		const { locationLine: line } = statusLine.renderQuietLines(120);
		expect(line).toBeNull();
	});
});
