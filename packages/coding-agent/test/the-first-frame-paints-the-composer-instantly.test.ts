import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import {
	applyComposerChrome,
	COMPOSER_INSET_COLS,
	COMPOSER_PLACEHOLDER,
	COMPOSER_RESTING_ROWS,
	ComposerHairline,
	computeEditorMaxHeight,
	mountLaunchComposer,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { renderBranch } from "@veyyon/coding-agent/modes/terminal/components/status-line/branch";
import {
	renderLocation,
	resolveLocationOptions,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/location";
import { segmentSeparator } from "@veyyon/coding-agent/modes/terminal/components/status-line/state-grammar";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { branchLabelFromFiles } from "@veyyon/coding-agent/utils/git-head";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import type { Component } from "@veyyon/tui";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";

/**
 * WHY: startup used to paint eight BLANK rows where the composer would live,
 * so the prompt appeared only when InteractiveMode.init finished — reading as
 * the composer "sliding up" seconds after launch. The launch card now mounts
 * the REAL composer into those rows, wrapped in the only chrome that has an
 * owner before the session exists, and the mode's zone mounts into the same
 * height around that same editor, so the handover changes text and never
 * position.
 *
 * What these tests close: the launch composer must render exactly
 * COMPOSER_RESTING_ROWS, must carry the real hairline bytes from the same
 * owner the mounted zone uses, must show the shared ghost placeholder, and
 * must be time-invariant — nothing on it may animate.
 *
 * The last suite closes the drift: it constructs a real InteractiveMode,
 * runs the real init, and sums what the MOUNTED zone renders at rest, so the
 * launch shape is compared against the live components rather than against a
 * second copy of the same number. A footline that gains a row, a status line
 * that stops collapsing, an extra pad row inside mountComposerZone or a
 * changed bottom margin all move that sum and fail here.
 *
 * The launch shape also paints the footline row, which is the row the live
 * status line takes over. Measured on a pty before it did: the card and its
 * composer at 84-102ms, the status row still blank at 1067ms. The half of that
 * row which needs no session — where you are and what branch you are on — is
 * rendered by the same owners the live row renders it through, so the
 * session's arrival adds segments to the right of text that does not move.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: it measures the resting state of a
 * fresh session on the home screen at three widths. A zone height that only
 * diverges under state the resting session never reaches — a live status
 * message, a multi-line draft, a mounted hook widget — is outside it, and so
 * is a divergence that appears only at a width not in the list. The location's
 * final WIDTH under a live row is outside it too: the live component refits
 * the path against the segments competing for the row, which do not exist yet
 * when the card paints. That the card's branch bytes equal the live segment's
 * is held next door, in
 * `modes/components/status-line/the-branch-reads-the-same-on-the-card-and-the-live-row.test.ts`.
 */

/**
 * The components `paintFirstFrame` mounts below the hero, built through the
 * same owner it calls. Rendering the real editor is the point: the card's
 * input row is the mode's input row, so a divergence between them cannot be
 * expressed.
 */
function launchComposer(): Component[] {
	const editor = new CustomEditor(getEditorTheme());
	applyComposerChrome(editor, resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE));
	editor.setMaxHeight(computeEditorMaxHeight(30));
	const mounted: Component[] = [];
	mountLaunchComposer({ addChild: child => mounted.push(child) }, editor);
	return mounted;
}

/** Every row the launch composer paints at `width`, in order. */
function launchRows(width: number): string[] {
	return launchComposer().flatMap(child => child.render(width));
}

/** The branch the fixture checkout's HEAD names. */
const FIXTURE_BRANCH = "launch-card-fixture";

/**
 * Run `body` with the project directory pointed at a checkout whose HEAD names {@link
 * FIXTURE_BRANCH}, written as files rather than by running git — which is how the card reads it.
 *
 * The process's own checkout cannot be the subject. A pull-request CI job checks out the merge
 * commit with a DETACHED HEAD, so `branchLabelFromFiles` answers null there and a cell that read the
 * branch off the ambient repository proved the row only on a machine that happened to sit on a
 * branch, and asserted nothing everywhere else. The fixture names the branch, so both the shown and
 * the withheld case are decided by this file.
 */
function onABranch(body: (branch: string) => void): void {
	const dir = TempDir.createSync("veyyon-launch-card-branch-");
	const gitDir = path.join(dir.path(), ".git");
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${FIXTURE_BRANCH}\n`);
	fs.writeFileSync(path.join(gitDir, "refs", "heads", FIXTURE_BRANCH), `${"0".repeat(40)}\n`);
	const previous = getProjectDir();
	setProjectDir(dir.path());
	try {
		expect(branchLabelFromFiles(getProjectDir())).toBe(FIXTURE_BRANCH);
		body(FIXTURE_BRANCH);
	} finally {
		// The project directory moves the process working directory with it, so it is restored BEFORE
		// the directory is removed: leaving the process inside a deleted cwd breaks every relative
		// path a later suite in this file resolves.
		setProjectDir(previous);
		dir.removeSync();
	}
}

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false);
});

describe("the launch composer", () => {
	it("renders exactly the resting zone's row count", () => {
		expect(launchRows(100)).toHaveLength(COMPOSER_RESTING_ROWS);
	});

	it("shows the hairline with its real bytes", () => {
		const hairline = new ComposerHairline().render(100)[0];
		expect(launchRows(100)).toContain(hairline);
	});

	it("shows the shared ghost placeholder inset by the composer margin", () => {
		const inputRow = launchRows(100).find(row => row.includes(COMPOSER_PLACEHOLDER));
		expect(inputRow).toBeDefined();
		expect(visibleWidth(inputRow as string)).toBeLessThanOrEqual(100);
	});

	it("never animates: identical bytes at different wall-clock times", async () => {
		const composer = launchComposer();
		const render = (): string[] => composer.flatMap(child => child.render(100));
		const first = render();
		await Bun.sleep(30);
		setSystemTime(new Date(Date.now() + 5_000));
		try {
			expect(render()).toEqual(first);
		} finally {
			setSystemTime();
		}
	});

	it("clips to narrow widths without throwing or wrapping", () => {
		for (const width of [1, 10, 40]) {
			const rows = launchRows(width);
			expect(rows).toHaveLength(COMPOSER_RESTING_ROWS);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("says where you are, on the row the live status line takes over", () => {
		const expected = renderLocation({
			projectDir: getProjectDir(),
			options: resolveLocationOptions(),
		}).content;
		expect(launchRows(100).some(row => row.includes(expected))).toBe(true);
	});

	it("clips the location to the preset's budget, not to the terminal", () => {
		// A 300-column terminal must not paint a 300-column path: the live row
		// clamps at the preset's `maxLength`, and a card that did not would
		// shorten the path the moment the session mounted.
		const narrowOptions = resolveLocationOptions();
		const expected = renderLocation({ projectDir: getProjectDir(), options: narrowOptions }).content;
		const row = launchRows(300).find(candidate => candidate.includes(expected));
		expect(row).toBeDefined();
		expect(visibleWidth(row as string)).toBeLessThan(300);
	});

	it("honors a path budget the session overrides the preset with", () => {
		settings.set("statusLine.segmentOptions", { path: { maxLength: 12 } });
		try {
			const located = renderLocation({ projectDir: getProjectDir(), options: resolveLocationOptions() }).content;
			expect(visibleWidth(located)).toBeLessThanOrEqual(12);
			const row = launchRows(100).find(candidate => candidate.includes(located));
			expect(row).toBeDefined();
			expect(row).toStartWith(`${" ".repeat(COMPOSER_INSET_COLS)}${located}`);
		} finally {
			settings.set("statusLine.segmentOptions", {});
		}
	});

	it("names the branch, after the location, joined the way the live row joins segments", () => {
		onABranch(branch => {
			const rendered = renderBranch(branch, false);
			expect(rendered).not.toBe("");
			const located = renderLocation({ projectDir: getProjectDir(), options: resolveLocationOptions() }).content;
			const row = launchRows(100).find(candidate => candidate.includes(located));
			expect(row).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}${located}${segmentSeparator()}${rendered}`);
		});
	});

	it("leaves the branch off the card when the row will not show one", () => {
		onABranch(() => {
			settings.set("git.enabled", false);
			try {
				const located = renderLocation({ projectDir: getProjectDir(), options: resolveLocationOptions() }).content;
				const row = launchRows(100).find(candidate => candidate.includes(located));
				expect(row).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}${located}`);
			} finally {
				settings.set("git.enabled", true);
			}
		});
	});

	it("shows no dirty marker, having run no `git status`", () => {
		// The card must not run a subprocess to paint this row, so it renders the
		// branch the way the live row renders it before its own asynchronous
		// lookup lands: clean, unmarked. A card that guessed differently would
		// change colour at the handover for no reason the reader can see.
		onABranch(branch => {
			const row = launchRows(100).find(candidate => candidate.includes(branch));
			expect(row).toBeDefined();
			expect(row).toContain(renderBranch(branch, false));
			expect(row).not.toContain("*");
		});
	});
});

describe("the mounted composer zone occupies the launch composer's rows", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from probing the real terminal during init().
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-first-frame-resting-height-");
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
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		await mode.init();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/**
	 * The zone is the tail of the root children starting at the first part
	 * mountComposerZone adds. Deriving the slice this way rather than from a
	 * child count means a row added inside mountComposerZone, or anything
	 * mounted after the zone, lands in the measurement instead of escaping it.
	 */
	function mountedZone(): Component[] {
		const children = mode.ui.children;
		const start = children.indexOf(mode.statusContainer);
		expect(start, "statusContainer must be mounted as a root child").toBeGreaterThanOrEqual(0);
		return children.slice(start);
	}

	function restingRows(width: number): number {
		return mountedZone().reduce((rows, child) => rows + child.render(width).length, 0);
	}

	it("renders the same number of rows the first frame reserved", () => {
		expect(restingRows(100)).toBe(COMPOSER_RESTING_ROWS);
	});

	it("renders the same number of rows the launch composer paints", () => {
		const width = 100;
		expect(restingRows(width)).toBe(launchRows(width).length);
	});

	it("holds that height across the widths the launch composer clips to", () => {
		for (const width of [40, 100, 200]) {
			expect(restingRows(width), `width ${width}`).toBe(launchRows(width).length);
		}
	});

	/**
	 * Counted from the BOTTOM of the block, because that is the end both sides
	 * share: the launch composer carries a leading blank standing for the status
	 * rows the live zone collapses to nothing at rest, so the two disagree on
	 * index 0 and must agree on everything under the input. A pad row added
	 * between the editor and the footline, a shortcuts row that stops
	 * collapsing, or a changed bottom margin moves one side and not the other,
	 * and lands the location on a row the live status line does not take over.
	 */
	function rowFromEnd(rows: readonly string[], index: number): number {
		return rows.length - 1 - index;
	}

	it("paints the location on the row the live footline occupies", () => {
		const width = 100;
		const live: string[] = [];
		let liveFootline = -1;
		for (const child of mountedZone()) {
			const rendered = child.render(width);
			if (child === mode.capabilityLine && rendered.length > 0) liveFootline = live.length;
			live.push(...rendered);
		}
		expect(liveFootline, "the live footline must render a row at rest").toBeGreaterThanOrEqual(0);

		const expected = renderLocation({
			projectDir: getProjectDir(),
			options: resolveLocationOptions(),
		}).content;
		const restingRowList = launchRows(width);
		const restingFootline = restingRowList.findIndex(row => row.includes(expected));
		expect(restingFootline, "the launch composer must paint the location somewhere").toBeGreaterThanOrEqual(0);

		expect(rowFromEnd(restingRowList, restingFootline)).toBe(rowFromEnd(live, liveFootline));
	});
});
