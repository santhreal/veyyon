import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { resetLaunchFactsForTest } from "@veyyon/coding-agent/modes/launch-facts";
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
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { branchLabelFromFiles, HEAD_REF_PREFIX, LOCAL_BRANCH_PREFIX } from "@veyyon/coding-agent/utils/git-head";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { Component } from "@veyyon/tui";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

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
 * The launch shape also paints the footline row, and that row is the real
 * status row rather than a sketch of it. Measured on a pty before it was: the
 * card and its composer at 84-102ms, the status row still blank at 1067ms. The
 * card now resolves the configured preset and renders every segment it can
 * answer for through the same gather-and-fit the live row uses, so the
 * session's arrival replaces values in place instead of adding segments.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: it measures the resting state of a
 * fresh session on the home screen at three widths. A zone height that only
 * diverges under state the resting session never reaches — a live status
 * message, a multi-line draft, a mounted hook widget — is outside it, and so
 * is a divergence that appears only at a width not in the list. That every
 * segment the preset declares reaches the card is held in
 * `the-card-and-the-live-row-are-one-row.test.ts`, and that the card's branch
 * bytes equal the live segment's is held in
 * `modes/components/status-line/the-branch-reads-the-same-on-the-card-and-the-live-row.test.ts`.
 *
 * The card refits the path against the segments competing for the row, exactly
 * as the live component does, so the width at which the budgeted location
 * survives whole depends on how long the checkout's path is. It is measured
 * here rather than written down: a fixed hundred columns fits on one machine
 * and refits on another, and a suite that hardcoded it would fail for the
 * length of a directory name.
 *
 * The card also states what the LAST launch recorded, so an ambient facts cache
 * would put a dirty marker and a context reading on these rows. The config root
 * is isolated for the file: what is asserted here is the row a project with no
 * history draws.
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

/**
 * The branch the fixture checkout's HEAD names. Short on purpose, like the fixture directory: the
 * card now paints the whole status row, so the left group competes for the row with every other
 * segment, and a 32-character temp directory plus a 19-character branch is clipped out of the row
 * this asserts on.
 */
const FIXTURE_BRANCH = "card-fixture";

/**
 * Run `body` with the project directory pointed at a fresh checkout, so a cell that asserts the
 * location bytes reads a path this file decides rather than the one the machine happens to have
 * checked out.
 *
 * The ambient checkout cannot be the subject. The location is clipped to the preset's budget and
 * then competes for the row with every other segment, so on a 63-character worktree path the card
 * sheds it and a cell looking for those bytes finds no row at all, while the same cell passes on a
 * 12-character CI checkout. Neither reading says anything about the card.
 */
function inAFixtureCheckout(body: (dir: string) => void): void {
	const dir = TempDir.createSync("vy-card-");
	const previous = getProjectDir();
	setProjectDir(dir.path());
	try {
		body(dir.path());
	} finally {
		// The project directory moves the process working directory with it, so it is restored BEFORE
		// the directory is removed: leaving the process inside a deleted cwd breaks every relative
		// path a later suite in this file resolves.
		setProjectDir(previous);
		dir.removeSync();
	}
}

/**
 * Run `body` inside {@link inAFixtureCheckout}, with the checkout's HEAD naming {@link
 * FIXTURE_BRANCH}, written as files rather than by running git — which is how the card reads it.
 *
 * A pull-request CI job checks out the merge commit with a DETACHED HEAD, so `branchLabelFromFiles`
 * answers null there and a cell that read the branch off the ambient repository proved the row only
 * on a machine that happened to sit on a branch, and asserted nothing everywhere else. The fixture
 * names the branch, so both the shown and the withheld case are decided by this file.
 */
function onABranch(body: (branch: string) => void): void {
	inAFixtureCheckout(dir => {
		const gitDir = path.join(dir, ".git");
		fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
		fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${FIXTURE_BRANCH}\n`);
		fs.writeFileSync(path.join(gitDir, "refs", "heads", FIXTURE_BRANCH), `${"0".repeat(40)}\n`);
		expect(branchLabelFromFiles(getProjectDir())).toBe(FIXTURE_BRANCH);
		body(FIXTURE_BRANCH);
	});
}
/** The location segment at the budget the preset sets for it, before any row competes for width. */
function budgetedLocation(): string {
	return renderLocation({ projectDir: getProjectDir(), options: resolveLocationOptions() }).content;
}

/**
 * The narrowest width the location is looked for at, and the reason a case that measures clipping
 * must land above it: below this the scan never looks, so a path short enough to survive here is
 * reported as fitting at the floor and one column narrower is a width nothing was measured at.
 */
const LOCATION_SCAN_FLOOR = 40;

/**
 * The narrowest terminal whose card row carries the budgeted location whole.
 *
 * Wider than this the path is untouched; narrower, the row refits it against the segments beside
 * it, which is what the live row does with the same path. Measured because the answer is the
 * length of the project's path, and asserted against a bound so a location that never survives
 * at any width fails here instead of quietly calibrating to 400.
 */
function widthThatFitsTheLocation(): number {
	const located = budgetedLocation();
	for (let width = LOCATION_SCAN_FLOOR; width <= 400; width += 1) {
		if (launchRows(width).some(row => row.includes(located))) return width;
	}
	throw new Error("the launch row carried the budgeted location at no width between 40 and 400 columns");
}
/**
 * Run `body` against a project directory long enough for the row to have to fit it, on a branch.
 *
 * Not the checkout the suite runs in. That path is `/srv/veyyon` on the CI runner, short enough to
 * survive whole at the scan floor above and short enough that the row keeps it and sheds the branch
 * instead, so every case that pins CLIPPING or the ORDER of the left group passed on a long
 * checkout and proved nothing on a short one. This directory exceeds any preset budget on every
 * machine, and it carries the one file `branchLabelFromFiles` reads, so the branch on the row comes
 * from the fixture rather than from wherever the tree happens to sit.
 */
function withDeepProject<T>(body: (project: string) => T): T {
	const deep = TempDir.createSync("@pi-first-frame-deep-project-");
	const nested = deep.join("a-directory-named-at-length", "and-another-one-below-it", "leaf");
	fs.mkdirSync(nested, { recursive: true });
	fs.mkdirSync(deep.join(".git"), { recursive: true });
	fs.writeFileSync(deep.join(".git", "HEAD"), `${HEAD_REF_PREFIX} ${LOCAL_BRANCH_PREFIX}${FIXTURE_BRANCH}\n`);
	const previousProjectDir = getProjectDir();
	setProjectDir(nested);
	try {
		return body(nested);
	} finally {
		setProjectDir(previousProjectDir);
		deep.removeSync();
	}
}

let isolated: IsolatedConfigRoot;

beforeAll(async () => {
	// The card states what the last launch recorded, and every suite sharing this sandbox home
	// records into the same file. Isolating it is what makes "no dirty marker" a claim about the
	// card rather than about which file ran first.
	isolated = enterIsolatedConfigRoot("launch-composer", { defaultProfile: true });
	resetLaunchFactsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false);
});

afterAll(() => {
	resetLaunchFactsForTest();
	isolated.restore();
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
		inAFixtureCheckout(() => {
			const expected = renderLocation({
				projectDir: getProjectDir(),
				options: resolveLocationOptions(),
			}).content;
			expect(launchRows(100).some(row => row.includes(expected))).toBe(true);
		});
	});

	/**
	 * One column narrower, the path is refit rather than dropped: still the same path, still ending
	 * at the directory the operator is in, only shorter. A card that shed the location instead would
	 * paint a row with nothing where the live row says where you are, and would grow one at the
	 * handover.
	 *
	 * Driven from a stated deep checkout, not the ambient one. A CI job checks out `/srv/veyyon`,
	 * whose whole path is shorter than the budget, so there is nothing to refit and the shortened
	 * row is the same bytes as the budgeted one — the cell read green on a workstation's deep
	 * worktree and red on the runner, and neither reading was about the card.
	 */
	it("shortens the path rather than dropping it when the row cannot afford the budget", () => {
		withDeepProject(project => {
			const fits = widthThatFitsTheLocation();
			// Above the scan floor, or `fits - 1` is a width the search never looked at and the case
			// below measures a row that was never asked to give anything up.
			expect(fits).toBeGreaterThan(LOCATION_SCAN_FLOOR);
			const tail = path.basename(project);
			const row = launchRows(fits - 1).find(candidate => candidate.includes(tail));

			expect(row).toBeDefined();
			expect(row).not.toContain(budgetedLocation());
			expect(row).toStartWith(" ".repeat(COMPOSER_INSET_COLS));
		});
	});

	it("clips the location to the preset's budget, not to the terminal", () => {
		// A 300-column terminal must not paint a 300-column path: the live row
		// clamps at the preset's `maxLength`, and a card that did not would
		// shorten the path the moment the session mounted.
		//
		// The ROW is 300 wide, because the row is now the real status row and its
		// right-hand group sits against the right edge exactly as the live one
		// does. The location inside it is what the budget governs.
		//
		// The directory is the deep fixture rather than this checkout, because the
		// budget only bites on a path longer than it: on a short checkout
		// (`/srv/veyyon` on the CI runner) the clipped and unclipped spellings are
		// the same string, and the case passed having proved nothing while failing
		// wherever the checkout was long enough to clip.
		withDeepProject(nested => {
			const expected = renderLocation({ projectDir: nested, options: resolveLocationOptions() }).content;
			const row = launchRows(300).find(candidate => candidate.includes(expected));
			expect(row).toBeDefined();
			expect(visibleWidth(row as string)).toBeLessThanOrEqual(300);
			// The clip happened at all: the segment is shorter than the directory it names.
			expect(visibleWidth(expected)).toBeLessThan(nested.length);
			// The unclipped path is absent: a row that had simply been given more room
			// would carry it, and would then shrink at the handover.
			expect(row).not.toContain(nested);
		});
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
		withDeepProject(project => {
			const branch = renderBranch(branchLabelFromFiles(project), false);
			// The fixture wrote the HEAD this reads, so a row without a branch is the card's doing.
			expect(branch).toContain(FIXTURE_BRANCH);
			const located = budgetedLocation();
			const row = launchRows(widthThatFitsTheLocation()).find(candidate => candidate.includes(located));
			// `toStartWith`, not `toBe`: the rest of the row is the preset's remaining
			// segments, which is the point of the card rendering the real row. What is
			// pinned here is the left group's content and its order.
			expect(row).toStartWith(`${" ".repeat(COMPOSER_INSET_COLS)}${located}${segmentSeparator()}${branch}`);
		});
	});

	it("leaves the branch off the card when the row will not show one", () => {
		onABranch(fixtureBranch => {
			settings.set("git.enabled", false);
			try {
				const located = renderLocation({ projectDir: getProjectDir(), options: resolveLocationOptions() }).content;
				const row = launchRows(100).find(candidate => candidate.includes(located));
				expect(row).toStartWith(`${" ".repeat(COMPOSER_INSET_COLS)}${located}`);
				// Nothing after the location is a branch: no separator-then-label, and
				// no bare label anywhere else on the row.
				expect(row).not.toContain(fixtureBranch);
			} finally {
				settings.set("git.enabled", true);
			}
		});
	});

	it("shows no dirty marker for a project that has recorded none", () => {
		// The card must not run a subprocess to paint this row. With nothing recorded by a previous
		// launch it renders the branch the way the live row renders it before its own asynchronous
		// lookup lands: clean, unmarked. What it does when a launch DID record a scan is held in
		// `the-launch-card-states-what-the-last-launch-knew.test.ts`; the config root is isolated
		// above so that file's recordings cannot answer for this one.
		onABranch(fixtureBranch => {
			const row = launchRows(100).find(candidate => candidate.includes(fixtureBranch));
			expect(row).toBeDefined();
			expect(row).toContain(renderBranch(fixtureBranch, false));
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
		inAFixtureCheckout(() => {
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
});
