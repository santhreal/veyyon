/**
 * What the context gauge read last time this project started, so the launch
 * card can state a number instead of `?`.
 *
 * The gauge's numerator is the prompt a session has not assembled yet: the
 * system prompt, the tool schemas, the context files and the skills. That lands
 * about half a second after the card paints, so the card rendered `? left` and
 * the session replaced it with `82% left` under a composer the operator was
 * already typing into.
 *
 * None of those four inputs depends on the conversation, so for a given
 * release, model and project they produce the same count on every launch. The
 * previous launch's count is therefore an answer rather than a guess. It is
 * recorded only while the conversation is empty — that is the at-rest cost the
 * card is asking about — and the session's own measurement displaces it the
 * moment there is one.
 *
 * WHEN IT IS WRONG. Editing an `AGENTS.md`, installing a skill, connecting an
 * MCP server or changing the compaction settings moves the reading without
 * moving the key. The first frame after such a change states the previous
 * number, the session corrects it, and the correction repaints in place because
 * {@link formatContextRemainingPercent} pads the number to a constant width.
 * The alternative on that frame is `?`, which is not more accurate.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getLaunchGaugeCachePath, getProjectDir, VERSION } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { settings } from "../../../../config/settings-instance";

/** One recorded at-rest reading, valid only for the key it was taken under. */
interface LaunchGaugeBaseline {
	key: string;
	percent: number;
}

/**
 * The release, the model and the project, as one string.
 *
 * The release is in the key because the system prompt and the tool schemas ship
 * with it, the model because it decides the window, and the project because the
 * context files are discovered from it. Three scalars the settings store
 * already holds: no registry, no catalog, no filesystem.
 */
function baselineKey(): string {
	return `${VERSION}|${settings.getModelRole("default") ?? ""}|${getProjectDir()}`;
}

/**
 * The at-rest percentage recorded for this key, or null to render `?`.
 *
 * Synchronous because the caller is a component's render, and a read the frame
 * cannot await is a read the frame does not get. The file is one small JSON
 * object in the profile cache.
 *
 * Every failure returns null, which is the state the gauge already spells. A
 * damaged file is reported and then overwritten by the next recording, so it
 * repairs itself; a missing file is every first launch in a project and says
 * nothing.
 */
export function readLaunchGaugePercent(): number | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(getLaunchGaugeCachePath(), "utf8"));
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Launch gauge baseline could not be read; the card will show `?` until the session lands", {
				error: errorMessage(err),
			});
		}
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const { key, percent } = parsed as Partial<LaunchGaugeBaseline>;
	if (typeof key !== "string" || key !== baselineKey()) return null;
	if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
	return Math.max(0, Math.min(100, percent));
}

/** The last value handed to {@link recordLaunchGaugePercent}, or -1 before the first. */
let lastRecorded = -1;

/**
 * Record the at-rest reading for the next launch, and hand back the write.
 *
 * Call only with a conversation of zero messages; see the module comment for
 * why anything else is not a baseline. That still means every redraw of an idle
 * session, which is why an unchanged reading returns on an integer compare
 * before it builds a key or touches the disk.
 *
 * Rounded to whole percent because that is what the gauge prints. The returned
 * promise settles when the file is on disk and never rejects; the product
 * discards it, because the value is worth one frame on the next launch and a
 * failed write costs that frame and nothing else.
 */
export function recordLaunchGaugePercent(percent: number): Promise<void> {
	if (!Number.isFinite(percent)) return Promise.resolve();
	const rounded = Math.max(0, Math.min(100, Math.round(percent)));
	if (rounded === lastRecorded) return Promise.resolve();
	lastRecorded = rounded;

	const record: LaunchGaugeBaseline = { key: baselineKey(), percent: rounded };
	const cachePath = getLaunchGaugeCachePath();
	return mkdir(path.dirname(cachePath), { recursive: true })
		.then(() => writeFile(cachePath, JSON.stringify(record)))
		.catch((err: unknown) => {
			logger.warn("Launch gauge baseline could not be written; the next launch will show `?`", {
				error: errorMessage(err),
			});
		});
}

/** Forget the last recorded reading, so a test can record the same value again. */
export function resetLaunchGaugeBaselineForTest(): void {
	lastRecorded = -1;
}
