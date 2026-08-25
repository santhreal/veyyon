/**
 * The composer footline emits nothing a terminal cannot draw, whatever the filesystem is called.
 *
 * THE DEFECT. The location zone read its two strings straight off disk and printed them: the
 * working directory through `pathSegment`, the refname out of `.git/HEAD` through `gitSegment`.
 * A directory name is arbitrary bytes on every platform veyyon runs on but Windows, and `HEAD`
 * is read as a file rather than through `git check-ref-format`, so each of these reached the
 * terminal verbatim:
 *
 *   - `\t` — advances to the next tab stop, so the painted row is wider than `visibleWidth`
 *     measured. The composer's own arithmetic is then wrong and the frame wraps.
 *   - `\r` — returns the cursor to column 0 and the rest of the row overwrites its own start.
 *   - `\x07` — rings the bell. The footline repaints on every keystroke and on every animation
 *     frame, so this is not one beep.
 *   - `\n` — ends the row early and pushes the composer up a line.
 *   - `\x1b[...` — a directory named `platform\x1b[31mservices` hands the terminal an escape
 *     sequence from this row. `[31m` only recolours; the same hole passes a cursor move, a
 *     scroll-region change or an erase.
 *
 * THE CLASS, which is wider than the footline: text from outside the process printed into a
 * frame whose width was measured on a different string. `sanitizeStatusText` already guarded
 * the PR title, the session name and the account label; the segments that read the filesystem,
 * and the one that prints the provider's model name, were the ones that did not call it.
 *
 * HOW THIS SUITE CLOSES IT. Two levels, because one is not enough.
 *
 * At the ROW, what `renderQuietLine` returns carries no C0/C1 control character and no escape
 * but an SGR, and the last SGR closes its run. That is the part a terminal cannot survive: an
 * erase, a cursor move, a scroll-region change, a bell. The preset list is read from
 * `STATUS_LINE_PRESETS` at run time, so a preset added later is swept rather than missed, and
 * every click state the expansion reaches is swept beside the resting row, because the clip and
 * the widen are separate paths over the same text.
 *
 * At the SEGMENT, no name a segment prints contributes an escape of its own. The row sweep
 * cannot see that on its own: it has to allow SGRs, since the theme paints in them, so a bare
 * `\x1b[31m` arriving through a model name is invisible there once a later segment closes the
 * run. Both levels are needed, and the mutation that removes any one sanitize call turns one of
 * them red.
 *
 * FIVE ROUTES, from four producers: the plain cwd, the multi-repo suffix, the linked-worktree
 * label, the refname, and the model name. The cwd and the refname come from fixture directories
 * on disk. The other three cannot be reached that way -- a worktree label needs a linked
 * worktree, a suffix needs a second repo, and a model name comes from the session -- so they are
 * driven through `renderSegment`, the same call the component makes.
 *
 * Two invariants ride along, because they are the other two ways this row breaks a terminal
 * and they are cheap to assert on the same sweep: the row never exceeds the width it was handed
 * (a row one cell too wide wraps, and the composer jumps a line), and the recorded click slots
 * stay inside it, in order, without overlapping (an out-of-range slot sends a click to the
 * wrong segment or to nothing).
 *
 * WHAT IT DOES NOT CATCH. Nothing here renders in a terminal: an emulator that draws `…` two
 * cells wide (a CJK-ambiguous width setting) still overflows by a cell per clip mark, and one
 * that draws a nerd-font glyph double-width still overflows by a cell per icon, because both
 * disagree with `visibleWidth`, which is the authority this row and this suite share. A NEW
 * segment is covered by the row sweep only if its text derives from the cwd, the refname, the
 * session name or the model name, which are the four the fixtures make hostile; one that reads
 * a sixth source unsanitized needs a route added to the segment-level case. Colour is not
 * asserted, only that a run is closed and that no run came from an input. The mouse is not
 * exercised: whether a click arrives at all depends on the terminal reporting SGR 1006, and a
 * terminal that does not report it leaves the row readable and inert, which no assertion here
 * would distinguish from a terminal that does.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line";
import { fitLocation } from "@veyyon/coding-agent/modes/components/status-line/component";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/components/status-line/presets";
import { renderSegment } from "@veyyon/coding-agent/modes/components/status-line/segments";
import type {
	SegmentContext,
	StatusLinePreset,
	StatusLineSegmentId,
} from "@veyyon/coding-agent/modes/components/status-line/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-statusline-terminal-safety-");

/** Read from the registry, so a preset added later is swept without editing this file. */
const PRESETS = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];

/** Every C0 and C1 control, and DEL. None of these is drawable. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** An SGR: the only escape the footline has any business emitting. */
const SGR_ONLY = /^\x1b\[[0-9;:]*m$/;

/** Any escape sequence, complete or not, so a truncated one is seen rather than skipped. */
const ANY_ESCAPE = /\x1b(?:\[[0-9;:]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g;

/** The terminal keeps a style until something closes it; a row must not leave one open. */
const CLOSES_A_RUN = /^\x1b\[(?:0|39|49|0;0)?m$/;

function given(columns: number): number {
	return columns - COMPOSER_INSET_COLS;
}

/**
 * The model name and the session name are hostile by default too, so the row sweep reaches
 * every segment printing text this process did not author, not only the two that read the
 * filesystem. A model name is provider text; a session name is a generated title.
 */
function stubSession(cwd: string, modelName = "claude\x1b[31m-3-7-sonnet"): AgentSession {
	return {
		messages: [],
		model: { id: "claude-3-7-sonnet", name: modelName, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 16000, contextWindow: 128000 }),
		state: {
			messages: [],
			model: { id: "claude-3-7-sonnet", name: modelName, contextWindow: 128000 },
		},
		sessionManager: {
			getCwd: () => cwd,
			// Hostile too, for the same reason.
			getSessionName: () => "ingest\r-normalizer\x07-session",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 17_000,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 2,
				cost: 0.42,
				tokensPerSecond: null,
			}),
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

/**
 * The spellings a checkout produces: the scripts a path is written in, and the bytes a
 * directory name or a hand-written `HEAD` may hold on Linux and macOS.
 */
const FIXTURES: { name: string; dirs: string[]; branch: string }[] = [
	{ name: "ascii", dirs: ["platform-services", "ingest-pipeline", "normalizer"], branch: "main" },
	{
		name: "long-branch",
		dirs: ["platform-services", "ingest-pipeline", "normalizer"],
		branch: "feature/statusline-model-retention-on-a-very-long-branch-name",
	},
	{ name: "cjk", dirs: ["データ処理基盤", "パッケージ", "正規化"], branch: "main" },
	{ name: "astral", dirs: ["📦packages", "🚀ingest", "🧪normalizer"], branch: "feature/📦-emoji-branch" },
	{ name: "combining", dirs: ["café\u0301-services", "ingest\u0301", "normalizer"], branch: "main" },
	{ name: "mixed", dirs: ["データ処理基盤", "📦packages", "normalizer"], branch: "release/データ-1.0" },
	{ name: "tab", dirs: ["platform\tservices", "ingest-pipeline", "norm\talizer"], branch: "main" },
	{ name: "newline", dirs: ["platform\nservices", "ingest-pipeline", "normalizer"], branch: "main" },
	{ name: "esc", dirs: ["platform\x1b[31mservices", "ingest-pipeline", "normalizer"], branch: "main" },
	{ name: "cr-bel", dirs: ["platform\rservices\x07", "ingest-pipeline", "normalizer"], branch: "main" },
	{ name: "control-branch", dirs: ["platform-services", "normalizer"], branch: "main\r\x07\x1b[2J" },
];

/** Resting, each half expanded, the hand-over between halves, and the collapse back. */
const ARMS: { label: string; toggle: StatusLineSegmentId[] }[] = [
	{ label: "collapsed", toggle: [] },
	{ label: "path-expanded", toggle: ["path"] },
	{ label: "branch-expanded", toggle: ["git"] },
	{ label: "handed-over", toggle: ["path", "git"] },
	{ label: "re-collapsed", toggle: ["path", "path"] },
];

/**
 * Six columns is the narrowest row that renders anything, and 400 is past any terminal; the
 * middle is dense where the location zone is being clipped, since that is where the arithmetic
 * is doing work.
 */
const WIDTHS = [
	6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 30, 34, 38, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 78, 80, 84, 90, 98,
	100, 110, 118, 120, 140, 160, 200, 400,
];

const cwds = new Map<string, string>();

/** Every combination the sweeps walk: fixture, preset, click state, width. */
function* rows(widths: readonly number[] = WIDTHS): Generator<{
	where: string;
	columns: number;
	line: string;
	component: StatusLineComponent;
}> {
	for (const fixture of FIXTURES) {
		for (const preset of PRESETS) {
			for (const arm of ARMS) {
				const component = new StatusLineComponent(stubSession(cwds.get(fixture.name) ?? ""));
				component.updateSettings({ preset });
				for (const columns of widths) {
					// Render first, so the toggle acts on a laid-out row the way a click does.
					component.renderQuietLine(given(columns));
					for (const half of arm.toggle) component.togglePathExpanded(half);
					const line = component.renderQuietLine(given(columns)) ?? "";
					yield { where: `${fixture.name}/${preset}/${arm.label}@${columns}`, columns, line, component };
					for (const half of arm.toggle) component.togglePathExpanded(half);
				}
			}
		}
	}
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
	for (const fixture of FIXTURES) {
		const dir = path.join(makeTempDir(), ...fixture.dirs);
		mkdirSync(path.join(dir, ".git"), { recursive: true });
		writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${fixture.branch}\n`);
		cwds.set(fixture.name, dir);
	}
});

describe("the footline prints nothing a terminal cannot draw", () => {
	it("emits no control character, and no escape but an SGR", () => {
		const bad: string[] = [];
		for (const { where, line } of rows([20, 40, 60, 78, 100, 120, 200])) {
			for (const seq of line.match(ANY_ESCAPE) ?? []) {
				if (!SGR_ONLY.test(seq)) bad.push(`${where}: escape ${JSON.stringify(seq)}`);
			}
			const control = stripAnsi(line).match(CONTROL);
			if (control) bad.push(`${where}: control ${JSON.stringify(control)}`);
		}
		expect(bad).toEqual([]);
	});

	it("closes the last style it opened, so nothing after the row inherits it", () => {
		const bad: string[] = [];
		for (const { where, line } of rows([20, 60, 78, 120])) {
			const styled = line.match(/\x1b\[[0-9;:]*m/g) ?? [];
			const last = styled.at(-1);
			if (last !== undefined && !CLOSES_A_RUN.test(last))
				bad.push(`${where}: ends styled with ${JSON.stringify(last)}`);
		}
		expect(bad).toEqual([]);
	});

	/**
	 * The producers, one call each, asserted on the segment rather than on the row.
	 *
	 * The row sweep above can only see what breaks a terminal outright: it has to allow SGRs,
	 * because the theme paints in them, so an SGR smuggled in through a name is invisible to it
	 * once anything else on the row closes the last run. Here the input carries `\x1b[31m` and
	 * the theme paints in truecolor (`38;2;r;g;b`) and closes with `39`/`49`, so a bare `31m` in
	 * a segment's output can only have come from the input.
	 *
	 * Two of these routes are unreachable from a temp directory -- the worktree label needs a
	 * linked worktree on disk and the suffix needs a second repo -- which is why every route is
	 * driven here rather than only the two the fixtures reach.
	 */
	it("lets no name it prints contribute an escape of its own", () => {
		const hostile = "plat\rform\x07services\x1b[2J\x1b[31m";
		const context = (over: Partial<SegmentContext>): SegmentContext =>
			({
				session: stubSession("/home/you/code/veyyon"),
				activeRepo: null,
				worktree: null,
				width: 120,
				options: {},
				git: { branch: "main", status: null, pr: null },
				...over,
			}) as unknown as SegmentContext;

		const hostileModel = stubSession("/home/you/code/veyyon", hostile);

		const routes = [
			[
				"worktree label",
				renderSegment(
					"path",
					context({ worktree: { projectName: hostile, worktreeName: "linked" } as SegmentContext["worktree"] }),
				),
			],
			[
				"multi-repo suffix",
				renderSegment(
					"path",
					context({
						activeRepo: {
							cwd: "/home/you/code/veyyon",
							relativeRepoRoot: hostile,
						} as SegmentContext["activeRepo"],
					}),
				),
			],
			["refname", renderSegment("git", context({ git: { branch: hostile, status: null, pr: null } }))],
			["model name", renderSegment("model", context({ session: hostileModel }))],
		] as const;

		const bad: string[] = [];
		for (const [name, rendered] of routes) {
			const control = stripAnsi(rendered.content).match(CONTROL);
			if (control) bad.push(`${name}: control ${JSON.stringify(control)}`);
			for (const seq of rendered.content.match(ANY_ESCAPE) ?? []) {
				if (!SGR_ONLY.test(seq)) bad.push(`${name}: escape ${JSON.stringify(seq)}`);
			}
			if (rendered.content.includes("\x1b[31m")) bad.push(`${name}: kept the input's own SGR`);
		}
		expect(bad).toEqual([]);
	});
});

describe("the footline fits the row it was given", () => {
	it("never renders wider than the budget, on any preset, width, script or click state", () => {
		const wide: string[] = [];
		for (const { where, columns, line } of rows()) {
			const budget = given(columns) - 1;
			if (visibleWidth(line) > budget) {
				wide.push(`${where}: ${visibleWidth(line)} > ${budget} :: ${JSON.stringify(stripAnsi(line))}`);
			}
		}
		expect(wide).toEqual([]);
	});

	it("records click slots inside the row, in order, never overlapping", () => {
		const bad: string[] = [];
		for (const { where, columns, line, component } of rows()) {
			const rowWidth = Math.max(visibleWidth(line), given(columns) - 1);
			const slots = component
				.getQuietSegmentBounds()
				.slice()
				.sort((a, b) => a.start - b.start);
			for (const slot of slots) {
				if (slot.start < 0 || slot.end > rowWidth) {
					bad.push(`${where}: slot ${slot.id} [${slot.start},${slot.end}) outside ${rowWidth}`);
				}
				if (slot.end < slot.start) bad.push(`${where}: slot ${slot.id} inverted`);
			}
			for (let i = 1; i < slots.length; i++) {
				if (slots[i]!.start < slots[i - 1]!.end) bad.push(`${where}: ${slots[i - 1]!.id} overlaps ${slots[i]!.id}`);
			}
			// A click can land on any column of the row, including past its end.
			for (let col = -2; col <= given(columns) + 2; col++) component.quietSegmentAt(col);
		}
		expect(bad).toEqual([]);
	});
});

describe("a width clip never cuts an escape in half", () => {
	/**
	 * The PR chip is a location part and it carries an OSC 8 hyperlink, so the front clip can
	 * land inside one. A cut between the opener and its terminator would leave the rest of the
	 * row inside a hyperlink target on every terminal that supports them.
	 */
	it("front-clips a part carrying an OSC 8 hyperlink without stranding the opener", () => {
		const bad: string[] = [];
		const link = "\x1b]8;;https://github.com/santhreal/veyyon/pull/907\x07 #907\x1b]8;;\x07";
		const parts = [
			{ id: "path", content: "\x1b[38;5;110m platform-services/ingest-pipeline/normalizer\x1b[39m", pin: 2 },
			{ id: "git", content: "\x1b[32m main\x1b[39m" },
			{ id: "pr", content: `\x1b[36m${link}\x1b[39m` },
		];
		for (let budget = 1; budget <= 90; budget++) {
			const { text } = fitLocation(parts, "  ·  ", budget);
			const openers = text.match(/\x1b\]8;;/g)?.length ?? 0;
			const terminated = text.match(/\x1b\]8;;[^\x07\x1b]*\x07/g)?.length ?? 0;
			if (openers !== terminated) bad.push(`budget ${budget}: ${openers} openers, ${terminated} terminated`);
			if (openers % 2 !== 0) bad.push(`budget ${budget}: unmatched pair :: ${JSON.stringify(text)}`);
			if (/\x1b(?![[\]])/.test(text)) bad.push(`budget ${budget}: stray ESC :: ${JSON.stringify(text)}`);
		}
		expect(bad).toEqual([]);
	});
});
