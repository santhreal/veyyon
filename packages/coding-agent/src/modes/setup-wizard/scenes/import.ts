import {
	routeSelectListMouse,
	type SelectItem,
	type SelectList,
	type SgrMouseEvent,
	truncateToWidth,
} from "@veyyon/tui";
import { errorMessage, getAgentDir } from "@veyyon/utils";
import { type ImportCandidate, importForeignItems, scanForeignConfig } from "../../../discovery/import-scan";
import { shortenPath } from "../../../tools/render-utils";
import { theme } from "../../theme/theme";
import type { SetupKeyHint, SetupScene, SetupSceneController, SetupSceneHost, SetupWizardContext } from "./types";
import { createWizardList, filterEscapeHint } from "./wizard-list";

const CONTINUE_VALUE = "__continue";
const MAX_VISIBLE = 10;

/** Import scan scene: offers every user-level foreign skill and CLAUDE.md/ AGENTS.md file found on the machine for per-item import into the active */
export class ImportSceneController implements SetupSceneController {
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
			// `~`-shortened: the absolute path is mostly the home prefix, which spent
			// the description column before reaching the part that identifies the
			// file, so every row read as the same truncated `/home/<user>/.claud`.
			description: `${candidate.providerName} · ${shortenPath(candidate.sourcePath)}`,
		}));
		items.push({
			value: CONTINUE_VALUE,
			label: `Import ${this.#selected.size} selected`,
			// Short enough for the ~38-column description column: the full sentence ("Nothing selected — continues without importing") was cut after
			description: this.#selected.size === 0 ? "Nothing to import; skips ahead" : "",
		});
		const list = createWizardList(items, MAX_VISIBLE);
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
			this.#status = [theme.fg("error", `${theme.status.error} Import failed: ${errorMessage(error)}`)];
			this.host.requestRender();
		}
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	/** A machine with more importable files than the step has rows turns this list searchable, and the list clears its own filter on Esc. Unclaimed, that Esc */
	escapeAction(): SetupKeyHint | undefined {
		return filterEscapeHint(this.#list);
	}

	/** Space is this scene's real verb: rows are toggled, not picked once. */
	keyHints(): readonly SetupKeyHint[] {
		return [
			{ keys: "↑↓", label: "select" },
			{ keys: "space", label: "toggle" },
			{ keys: "enter", label: "confirm" },
		];
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

	render(width: number, rows?: number): readonly string[] {
		const lines = [
			theme.fg("muted", "Space toggles an item · Enter imports the checked ones."),
			theme.fg("dim", "Importing copies into this profile; the originals are left untouched."),
			"",
		];
		this.#listRowStart = lines.length;
		if (rows !== undefined) {
			const statusRows = this.#status.length > 0 ? this.#status.length + 1 : 0;
			this.#list.setRowBudget(Math.max(1, rows - lines.length - statusRows));
		}
		const ll = this.#list.render(width);
		for (let li = 0; li < ll.length; li++) lines.push(ll[li]!);
		if (this.#status.length > 0) {
			lines.push("", ...this.#status.map(line => truncateToWidth(line, width)));
		}
		return lines;
	}
}

/** Scan results carried from `shouldRun`, which `selectSetupScenes` always runs first, to `mount`, which is sync. */
const scannedCandidates = new WeakMap<SetupWizardContext, ImportCandidate[]>();

export const importSetupScene: SetupScene = {
	id: "import-config",
	stepLabel: "Import",
	title: "Import existing config",
	// Introduced-at-major floor: ships in v1, so it is part of first-install
	// onboarding. shouldRun still gates it on there being something to import.
	minVersion: 1,
	shouldRun: async ctx => {
		const candidates = await scanForeignConfig();
		scannedCandidates.set(ctx, candidates);
		return candidates.length > 0;
	},
	mount: host => new ImportSceneController(host, scannedCandidates.get(host.ctx) ?? []),
};
