import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent, truncateToWidth } from "@veyyon/pi-tui";
import { type ImportCandidate, importForeignItems, scanForeignConfig } from "../../../discovery/import-scan";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const CONTINUE_VALUE = "__continue";
const MAX_VISIBLE = 10;

/**
 * Import scan scene: offers every user-level foreign skill and CLAUDE.md/
 * AGENTS.md file found on the machine for per-item import into the active
 * profile. Everything starts selected; importing copies — the originals keep
 * loading ambiently as the base layer (discovery.importForeignConfig).
 */
class ImportSceneController implements SetupSceneController {
	title = "Import existing config";
	subtitle = "Skills and instructions from other tools were found on this machine.";
	#candidates: ImportCandidate[];
	#selected: Set<string>;
	#list: SelectList;
	#status: string[] = [];
	#importing = false;
	/** Render line where the select list begins. */
	#listRowStart = 0;

	constructor(
		private readonly host: SetupSceneHost,
		candidates: ImportCandidate[],
	) {
		this.#candidates = candidates;
		this.#selected = new Set(candidates.map(candidate => candidate.sourcePath));
		this.#list = this.#buildList(0);
	}

	#buildList(selectedIndex: number): SelectList {
		const items: SelectItem[] = this.#candidates.map(candidate => ({
			value: candidate.sourcePath,
			label: `${this.#selected.has(candidate.sourcePath) ? theme.checkbox.checked : theme.checkbox.unchecked} ${
				candidate.kind === "skill" ? `skill: ${candidate.name}` : candidate.name
			}`,
			description: `${candidate.providerName} · ${candidate.sourcePath}`,
		}));
		items.push({
			value: CONTINUE_VALUE,
			label: `Import ${this.#selected.size} selected`,
			description: this.#selected.size === 0 ? "Nothing selected — continues without importing" : "",
		});
		const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme());
		list.setSelectedIndex(selectedIndex);
		list.onSelect = item => this.#activate(item.value);
		list.onCancel = () => this.host.finish("skipped");
		return list;
	}

	#activate(value: string): void {
		if (this.#importing) return;
		if (value === CONTINUE_VALUE) {
			void this.#commit();
			return;
		}
		if (this.#selected.has(value)) this.#selected.delete(value);
		else this.#selected.add(value);
		this.#rebuild();
	}

	#rebuild(): void {
		const selectedValue = this.#list.getSelectedItem()?.value;
		const index = Math.max(
			0,
			this.#candidates.findIndex(candidate => candidate.sourcePath === selectedValue),
		);
		this.#list = this.#buildList(selectedValue === CONTINUE_VALUE ? this.#candidates.length : index);
		this.host.requestRender();
	}

	async #commit(): Promise<void> {
		if (this.#importing) return;
		this.#importing = true;
		const chosen = this.#candidates.filter(candidate => this.#selected.has(candidate.sourcePath));
		if (chosen.length === 0) {
			this.host.finish("done");
			return;
		}
		try {
			const { getAgentDir } = await import("@veyyon/pi-utils");
			const outcome = await importForeignItems(getAgentDir(), chosen);
			this.#status = [
				theme.fg(
					"success",
					`${theme.status.success} Imported ${outcome.imported.length} item(s)` +
						(outcome.skipped.length > 0 ? ` (${outcome.skipped.length} already present)` : ""),
				),
			];
			this.host.requestRender();
			this.host.finish("done");
		} catch (error) {
			this.#importing = false;
			this.#status = [
				theme.fg(
					"error",
					`${theme.status.error} Import failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
			this.host.requestRender();
		}
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	handleInput(data: string): void {
		if (this.#importing) return;
		if (data === " ") {
			const item = this.#list.getSelectedItem();
			if (item && item.value !== CONTINUE_VALUE) {
				this.#activate(item.value);
				return;
			}
		}
		this.#list.handleInput(data);
	}

	/** Wheel moves the highlight; click toggles the row (or confirms Continue). */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#importing) return;
		routeSelectListMouse(this.#list, event, line - this.#listRowStart);
	}

	render(width: number): readonly string[] {
		const lines = [
			theme.fg("muted", "Space toggles an item · imports copy into your profile; originals keep loading."),
			"",
		];
		this.#listRowStart = lines.length;
		lines.push(...this.#list.render(width));
		if (this.#status.length > 0) {
			lines.push("", ...this.#status.map(line => truncateToWidth(line, width)));
		}
		return lines;
	}
}

/** Scan result carried from shouldRun (always called before mount) to mount, which is sync. */
let scannedCandidates: ImportCandidate[] = [];

export const importSetupScene: SetupScene = {
	id: "import-config",
	title: "Import existing config",
	minVersion: 2,
	shouldRun: async () => {
		scannedCandidates = await scanForeignConfig();
		return scannedCandidates.length > 0;
	},
	mount: host => new ImportSceneController(host, scannedCandidates),
};
