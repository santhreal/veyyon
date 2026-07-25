import type { Component, SelectItem } from "@veyyon/tui";
import type { ReleaseListing } from "../../cli/update-cli";
import { getSelectListTheme } from "../../modes/theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import type { ModalShortcut } from "./modal-shell";

/**
 * Version rollback picker — a searchable modal list of every published version.
 *
 * Wraps {@link ModalSelectListComponent} (the same medium ModalShell picker the
 * theme selector uses), so it inherits type-to-search, mouse, and the shell
 * chrome for free. Three things are specific to rollback:
 *
 *  - Each row is annotated: its publish date, and a marker on the version you
 *    are running now (`current`) and the one you were on before the last update
 *    (`previous`), so the list reads as a history you can navigate.
 *  - `Ctrl+O` opens the highlighted version's changelog in the browser. It has
 *    to be a non-printable key because every printable key is swallowed by the
 *    list's type-to-search filter. The footer names it (`^O changelog`) so the
 *    affordance is discoverable, not a secret.
 *  - Enter does not roll back immediately: it opens a one-key CONFIRM step
 *    ("Roll back to vX?"), because the list also filters on typed keys and a
 *    stray Enter must never silently reinstall a different version. Confirm
 *    applies; Esc returns to the list.
 *
 * The component stays pure: it emits the chosen version through `onSelect` (only
 * after confirmation) and the changelog request through `onOpenChangelog`, and
 * leaves the install to its host, so it renders and unit-tests without an
 * installer or a live session.
 */

/** Ctrl+O (ASCII SI, 0x0f): opens the highlighted version's changelog. */
export const ROLLBACK_CHANGELOG_KEY = "\x0f";

/** Modal title in the browse (pick-a-version) state. */
export const ROLLBACK_PICK_TITLE = "Roll back version";

/** Footer chips for the browse state. `^O` is non-clickable (keyboard only);
 *  `confirm`/`close` keep their ids so a mouse click routes like Enter/Esc. */
export const ROLLBACK_PICK_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "^O changelog" },
	{ label: "enter roll back", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

/** Footer chips for the confirm state. */
export const ROLLBACK_CONFIRM_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "enter confirm", clickable: true, id: "confirm" },
	{ label: "esc back", clickable: true, id: "close" },
];

/** Confirm-state title for rolling back to `version` (bare, e.g. `1.0.11`). Kept
 *  short so it never truncates in the modal title bar; the restart caveat rides
 *  the tip line ({@link ROLLBACK_CONFIRM_TIP}). */
export function rollbackConfirmTitle(version: string): string {
	return `Roll back to v${version}?`;
}

/** Browse-state tip line. */
export const ROLLBACK_PICK_TIP = "Tip · type to search";
/** Confirm-state tip line: the caveat the title no longer carries. */
export const ROLLBACK_CONFIRM_TIP = "Takes effect on restart";

/**
 * The row's LEFT label: the version, with a `· current`/`· previous` marker
 * appended for the two special rows. The marker rides the left-aligned label
 * (not the right-aligned date description) so it is never clipped by the narrow
 * description column — the whole reason a reader opens this list is to see which
 * version they are on. `current` wins if a version is somehow both.
 */
export function rollbackRowLabel(
	release: ReleaseListing,
	currentVersion: string,
	previousVersion: string | undefined,
): string {
	if (release.version === currentVersion) return `${release.version} · current`;
	if (previousVersion !== undefined && release.version === previousVersion) return `${release.version} · previous`;
	return release.version;
}

/** The row's RIGHT description: the publish date as `YYYY-MM-DD`, or undefined
 *  when the registry reported none. */
export function rollbackRowDate(release: ReleaseListing): string | undefined {
	const date = release.publishedAt;
	return date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : undefined;
}

const ENTER_KEYS = new Set(["\r", "\n"]);
const ESC_KEY = "\x1b";

export class RollbackPickerComponent implements Component {
	#inner: ModalSelectListComponent;
	#currentVersion: string;
	#onSelect: (version: string) => void;
	#onOpenChangelog: (version: string) => void;
	#onRequestRender?: () => void;
	/** Version awaiting confirmation; undefined in the browse state. */
	#pending: string | undefined;

	constructor(
		releases: readonly ReleaseListing[],
		currentVersion: string,
		previousVersion: string | undefined,
		onSelect: (version: string) => void,
		onCancel: () => void,
		onOpenChangelog: (version: string) => void,
	) {
		this.#currentVersion = currentVersion;
		this.#onSelect = onSelect;
		this.#onOpenChangelog = onOpenChangelog;
		const items: SelectItem[] = releases.map(release => ({
			value: release.version,
			label: rollbackRowLabel(release, currentVersion, previousVersion),
			description: rollbackRowDate(release),
		}));
		// Start on the current version so the list opens centered on "where you are".
		const currentIndex = releases.findIndex(release => release.version === currentVersion);
		this.#inner = new ModalSelectListComponent(
			{
				title: ROLLBACK_PICK_TITLE,
				items,
				theme: getSelectListTheme(),
				selectedIndex: currentIndex >= 0 ? currentIndex : 0,
				maxVisible: 12,
				tipCandidates: [ROLLBACK_PICK_TIP],
				shortcuts: ROLLBACK_PICK_SHORTCUTS,
			},
			{
				// The list's Enter fires here; open the confirm step rather than
				// applying, so a stray Enter during type-search can't reinstall.
				onSelect: item => this.#requestConfirm(item.value),
				onCancel,
			},
		);
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		this.#inner.setOnRequestRender(cb);
	}

	getSelectList() {
		return this.#inner.getSelectList();
	}

	/** True while the confirm step is showing (test/host observability). */
	isConfirming(): boolean {
		return this.#pending !== undefined;
	}

	handleInput(data: string): void {
		if (this.#pending !== undefined) {
			// Confirm state: one key decides. Enter applies, Esc returns to the list,
			// ^O opens the pending version's changelog; everything else is swallowed
			// so a stray keystroke cannot leak into the list underneath.
			if (ENTER_KEYS.has(data)) {
				const version = this.#pending;
				this.#exitConfirm();
				this.#onSelect(version);
			} else if (data === ESC_KEY) {
				this.#exitConfirm();
			} else if (data === ROLLBACK_CHANGELOG_KEY) {
				this.#onOpenChangelog(this.#pending);
			}
			return;
		}
		// Browse state: ^O opens the highlighted row's changelog; all else (nav,
		// type-to-search, Enter→onSelect) flows to the list.
		if (data === ROLLBACK_CHANGELOG_KEY) {
			const item = this.#inner.getSelectList().getSelectedItem();
			if (item) this.#onOpenChangelog(item.value);
			return;
		}
		this.#inner.handleInput(data);
	}

	#requestConfirm(version: string): void {
		// Rolling back to the version already running is a no-op; the row is marked
		// `· current`, so stay in the list rather than confirm a pointless install.
		if (version === this.#currentVersion) return;
		this.#pending = version;
		this.#inner.setTitle(rollbackConfirmTitle(version));
		this.#inner.setShortcuts(ROLLBACK_CONFIRM_SHORTCUTS);
		this.#inner.setTipCandidates([ROLLBACK_CONFIRM_TIP]);
		this.#onRequestRender?.();
	}

	#exitConfirm(): void {
		this.#pending = undefined;
		this.#inner.setTitle(ROLLBACK_PICK_TITLE);
		this.#inner.setShortcuts(ROLLBACK_PICK_SHORTCUTS);
		this.#inner.setTipCandidates([ROLLBACK_PICK_TIP]);
		this.#onRequestRender?.();
	}

	render(width: number): string[] {
		return this.#inner.render(width);
	}

	invalidate(): void {
		this.#inner.invalidate();
	}
}
