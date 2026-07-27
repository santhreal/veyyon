/**
 * Print an Agent Control Center view as ANSI, for the render proofs.
 *
 * The card cannot be captured by launching veyyon and pressing `/agents`: two of
 * its three views show LIVE state -- which agents are running and what they have
 * said -- so a live capture would show whatever this machine happened to be
 * doing, and would show nothing at all on an idle session. This script seeds the
 * process-global {@link AgentRegistry} and a pair of session files, then renders
 * the real component, so every ground and every view comes out identical on
 * every machine.
 *
 * `--variant before` reproduces the source-tab strip the redesign deleted, so
 * the pair compares the real old render against the real new one rather than
 * against a description of it.
 *
 * Usage:
 *
 *     bun scripts/demos/render-agent-control-center.ts --view live [--variant after] [--theme titanium]
 *       | bun scripts/demos/render-proof.ts --out /tmp/proof/acc-live --width 120
 *
 * Views: `live`, `lens`, `room`, `agents`. `--variant before` is only meaningful
 * for `agents`, which is the view the old tab strip sat on top of.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../../packages/coding-agent/src/config/settings";
import { AgentDashboard } from "../../packages/coding-agent/src/modes/components/agent-dashboard";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "../../packages/coding-agent/src/registry/agent-registry";
import { flag, renderWidth } from "./render-args";

const view = flag("view", "live");
const variant = flag("variant", "after");
const themeName = flag("theme", "titanium");
const width = renderWidth();
const ROWS = 34;

/**
 * Agents a stock install discovers, for the deleted strip's counts.
 *
 * Read from the card itself would be better, but the count the OLD strip showed
 * is the count of BUNDLED agents specifically, which the new card no longer
 * separates out -- so it is stated here, matching what `discoverAgents` returns
 * with no project or user agents present.
 */
const BUNDLED_AGENT_COUNT = 6;

await initTheme(false, "unicode", false, themeName, themeName);

// Fixed geometry: the card sizes itself from the live terminal, and a proof that
// changes shape with the window it was generated in cannot be compared.
Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => ROWS });
Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => width });

const settings = {
	get: () => undefined,
	set: () => {},
	getModelRole: () => undefined,
} as unknown as Settings;

/** A session file whose turns the Room view reads. */
async function seedTranscript(dir: string, name: string, turns: Array<[string, string]>): Promise<string> {
	const file = path.join(dir, `${name}.jsonl`);
	let at = Date.parse("2026-07-25T09:14:00.000Z");
	const lines = turns.map(([role, text]) => {
		at += 21_000;
		return JSON.stringify({
			type: "message",
			id: `${name}-${at}`,
			parentId: null,
			timestamp: new Date(at).toISOString(),
			message: { role, content: [{ type: "text", text }] },
		});
	});
	await fs.writeFile(file, `${lines.join("\n")}\n`);
	return file;
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-acc-proof-"));
const registry = AgentRegistry.global();

if (view === "live" || view === "lens" || view === "room") {
	const mainFile = await seedTranscript(dir, "main", [
		["user", "Audit the subagent settings and redesign the control center."],
		["assistant", "Splitting this: one pass over the enable semantics, one over the card itself."],
		["assistant", "Both passes are out. Waiting on the review before I touch the docs."],
	]);
	const scoutFile = await seedTranscript(dir, "scout", [
		["assistant", "Read agent-dashboard.ts end to end. The tab strip filters on AgentSource and nothing else."],
		["assistant", "Four tabs, two of them empty on a stock install. Nothing downstream reads the selection."],
	]);
	const reviewerFile = await seedTranscript(dir, "reviewer", [
		["assistant", "The inspector spends seven of nine lines on model resolution stages that agree with each other."],
	]);

	registry.register({ id: MAIN_AGENT_ID, displayName: "Main Session", kind: "main", session: null });
	registry.get(MAIN_AGENT_ID)!.sessionFile = mainFile;

	registry.register({
		id: "task-7f21",
		displayName: "survey the control center component",
		kind: "sub",
		session: null,
		sessionFile: scoutFile,
		model: "anthropic/claude-opus-5",
	});
	registry.setActivity("task-7f21", "reading agent-dashboard.ts, 1,436 lines");

	registry.register({
		id: "task-b904",
		displayName: "read the inspector adversarially",
		kind: "sub",
		session: null,
		sessionFile: reviewerFile,
		model: "anthropic/claude-sonnet-5",
	});
	registry.setActivity("task-b904", "grep for enableStateDisplay callers");

	registry.register({
		id: "task-3ac8",
		displayName: "collect the theme matrix",
		kind: "sub",
		session: null,
		model: "anthropic/claude-sonnet-5",
	});
	registry.setStatus("task-3ac8", "idle");

	// Spawn times and activity stamps are wall-clock at registration, so every row
	// would read the same age and the roster would order on id alone. Stamping them
	// gives the proof the shape a real fan-out has: an older agent still working, a
	// newer one just started, and one that has already finished.
	const now = Date.now();
	const stamp = (id: string, ageMs: number, idleMs: number) => {
		const ref = registry.get(id);
		if (!ref) return;
		ref.createdAt = now - ageMs;
		ref.lastActivity = now - idleMs;
	};
	stamp(MAIN_AGENT_ID, 14 * 60_000, 4_000);
	stamp("task-7f21", 6 * 60_000, 3_000);
	stamp("task-b904", 4 * 60_000, 51_000);
	stamp("task-3ac8", 9 * 60_000, 2 * 60_000);
}

const dashboard = await AgentDashboard.create(process.cwd(), settings, ROWS, {});

if (variant === "before" && view === "agents") {
	// The strip this change deleted, rebuilt from the removed `#buildTabs` +
	// `#renderTabBar` pair: four tabs over one source field, `All` holding every
	// row and `Bundled` holding the same rows again because a stock install has
	// no project or user agents. Everything below the strip is the real card.
	const tabs = [
		["All", BUNDLED_AGENT_COUNT],
		["Bundled", BUNDLED_AGENT_COUNT],
	] as const;
	const strip = [
		" ",
		...tabs.map(([label, count], index) =>
			index === 0 ? theme.bg("selectedBg", ` ${label} (${count}) `) : theme.fg("muted", ` ${label} (${count}) `),
		),
	].join("");
	const lines = [...dashboard.render(width)];
	// Swap the new strip row for the old one, in place, so the pair differs only
	// where the change is.
	const stripRow = lines.findIndex(line => line.includes("Live ("));
	if (stripRow >= 0) {
		const prefix = lines[stripRow].slice(0, lines[stripRow].indexOf("\x1b") + 0);
		lines[stripRow] = `${prefix}${strip}`;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
} else {
	// `\x1b[C` is right-arrow: the card opens on Live when something is running,
	// so each view is one deterministic walk from there.
	// The card opens on Live when something is running and on Agents when nothing
	// is, and the `agents` view is the one case that seeds no registry -- so it is
	// already showing and needs no walk at all.
	if (view === "room") dashboard.handleInput("\x1b[C");
	if (view === "lens") {
		dashboard.handleInput("\x1b[B");
		dashboard.handleInput("\r");
	}
	// The Room reads its transcripts asynchronously; give that read a turn to land
	// before the frame is taken, or the proof captures the loading row.
	await Bun.sleep(50);
	process.stdout.write(`${dashboard.render(width).join("\n")}\n`);
}

dashboard.dispose();
await fs.rm(dir, { recursive: true, force: true });
