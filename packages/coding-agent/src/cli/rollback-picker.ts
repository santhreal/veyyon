/**
 * Standalone interactive rollback picker for `veyyon rollback` (bare, on a TTY).
 *
 * Mounts {@link RollbackPickerComponent} in a session-free TUI host on the
 * terminal's alternate screen — the same lightweight pattern the session picker
 * uses ({@link selectSession}) — so the list scrolls, rows are searchable and
 * clickable, and each row's changelog opens in the browser. The picker only
 * chooses a version; the install runs AFTER the TUI has torn down, so its
 * progress prints to a clean, restored terminal (never behind the alt screen).
 */
import { ProcessTerminal, TUI } from "@veyyon/tui";
import { APP_NAME, changelogUrlForVersion, getUpdateHistoryPath, VERSION } from "@veyyon/utils";
import chalk from "chalk";
import { RollbackPickerComponent } from "../modes/components/rollback-picker";
import { openPath } from "../utils/open";
import { getAllReleases, previousVersionFromHistory, readUpdateHistory, rollbackToVersion } from "./update-cli";

/**
 * Show the interactive picker, then roll back to the chosen version. Cancelling
 * (Esc) or selecting the version already running is a clean no-op. Fetch or
 * install failures are reported loudly on stderr with a non-zero exit code
 * (never a silent empty picker — Law 10).
 */
export async function runRollbackPicker(): Promise<void> {
	let releases: Awaited<ReturnType<typeof getAllReleases>>;
	try {
		releases = await getAllReleases();
	} catch (err) {
		process.stderr.write(
			chalk.red(
				`Could not fetch published versions: ${err instanceof Error ? err.message : String(err)}\n` +
					`Check your connection and retry, or run \`${APP_NAME} rollback --list\`.\n`,
			),
		);
		process.exitCode = 1;
		return;
	}
	if (releases.length === 0) {
		process.stderr.write("No published versions found.\n");
		process.exitCode = 1;
		return;
	}

	const previousVersion = previousVersionFromHistory(await readUpdateHistory(getUpdateHistoryPath()), VERSION);

	const chosen = await pickVersion(releases, previousVersion);
	if (chosen === null || chosen === VERSION) return;

	// The TUI has stopped (pickVersion calls ui.stop before resolving), so the
	// terminal is restored and the installer's progress prints normally.
	try {
		await rollbackToVersion(chosen);
	} catch (err) {
		process.stderr.write(chalk.red(`${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
}

/**
 * Run the picker overlay and resolve to the selected version, or null on cancel.
 * Split out so the fetch/guard logic above stays testable without a terminal,
 * and to keep the TUI lifecycle (start → overlay → stop) in one place.
 */
function pickVersion(
	releases: readonly Awaited<ReturnType<typeof getAllReleases>>[number][],
	previousVersion: string | undefined,
): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const finish = (value: string | null): void => {
		if (resolved) return;
		resolved = true;
		ui.stop();
		resolve(value);
	};

	const picker = new RollbackPickerComponent(
		releases,
		VERSION,
		previousVersion,
		version => finish(version),
		() => finish(null),
		version => openPath(changelogUrlForVersion(version)),
	);
	picker.setOnRequestRender(() => ui.requestRender());
	ui.showOverlay(picker, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(picker);
	ui.start();
	return promise;
}
