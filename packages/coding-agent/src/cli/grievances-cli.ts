import { existsSync } from "node:fs";
import { subCellBar } from "@veyyon/tui/sub-cell-bar";
import { formatCount, getAutoQaDbDir, pluralize } from "@veyyon/utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { flushGrievances, openAutoQaDb } from "../tools/report-tool-issue";
import { EXIT_USAGE } from "./exit-codes";

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

export interface ListGrievancesOptions {
	limit: number;
	tool?: string;
	json: boolean;
}

export interface CleanGrievancesOptions {
	id?: number;
	tool?: string;
	all?: boolean;
	json?: boolean;
}

export interface PushGrievancesOptions {
	json?: boolean;
}
function grievanceDbUnavailable(): { reason: "no_db" | "unreadable_db"; message: string } {
	const dbPath = getAutoQaDbDir();
	if (existsSync(dbPath)) {
		return {
			reason: "unreadable_db",
			message: `Grievances database at ${dbPath} exists but could not be opened. Check its permissions; reported tool issues are not being recorded.`,
		};
	}
	return {
		reason: "no_db",
		message: "No grievances database found. Enable auto-QA with VEYYON_AUTO_QA=1 or the dev.autoqa setting.",
	};
}

function reportGrievanceDbUnavailable(json: boolean | undefined, unavailable: { message: string }): void {
	if (json) console.error(chalk.dim(unavailable.message));
	else console.log(chalk.dim(unavailable.message));
}

export async function listGrievances(options: ListGrievancesOptions): Promise<void> {
	const db = openAutoQaDb();
	if (!db) {
		if (options.json) console.log("[]");
		reportGrievanceDbUnavailable(options.json, grievanceDbUnavailable());
		return;
	}

	try {
		let rows: GrievanceRow[];
		if (options.tool) {
			rows = db
				.prepare("SELECT id, model, version, tool, report FROM grievances WHERE tool = ? ORDER BY id DESC LIMIT ?")
				.all(options.tool, options.limit) as GrievanceRow[];
		} else {
			rows = db
				.prepare("SELECT id, model, version, tool, report FROM grievances ORDER BY id DESC LIMIT ?")
				.all(options.limit) as GrievanceRow[];
		}

		if (options.json) {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}

		if (rows.length === 0) {
			console.log(chalk.dim("No grievances recorded yet."));
			return;
		}

		for (const row of rows) {
			console.log(
				`${chalk.dim(`#${row.id}`)} ${chalk.cyan(row.tool)} ${chalk.dim(`(${row.model} v${row.version})`)}`,
			);
			console.log(`  ${row.report}`);
			console.log();
		}

		console.log(chalk.dim(`Showing ${rows.length} most recent${options.tool ? ` for ${options.tool}` : ""}`));
	} finally {
		db.close();
	}
}

export async function cleanGrievances(options: CleanGrievancesOptions): Promise<void> {
	const selectors = [options.id !== undefined, !!options.tool, !!options.all].filter(Boolean).length;
	if (selectors === 0) {
		console.error(chalk.red("Specify exactly one of --id, --tool, or --all."));
		process.exitCode = EXIT_USAGE;
		return;
	}
	if (selectors > 1) {
		console.error(chalk.red("--id, --tool, and --all are mutually exclusive."));
		process.exitCode = EXIT_USAGE;
		return;
	}

	const db = openAutoQaDb();
	if (!db) {
		if (options.json) console.log(JSON.stringify({ deleted: 0 }));
		reportGrievanceDbUnavailable(options.json, grievanceDbUnavailable());
		return;
	}

	try {
		let deleted = 0;
		if (options.id !== undefined) {
			const result = db.prepare("DELETE FROM grievances WHERE id = ?").run(options.id);
			deleted = Number(result.changes);
		} else if (options.tool) {
			const result = db.prepare("DELETE FROM grievances WHERE tool = ?").run(options.tool);
			deleted = Number(result.changes);
		} else {
			const result = db.prepare("DELETE FROM grievances").run();
			deleted = Number(result.changes);
			try {
				db.prepare("DELETE FROM sqlite_sequence WHERE name = 'grievances'").run();
			} catch {}
		}

		if (options.json) {
			console.log(JSON.stringify({ deleted }));
			return;
		}

		if (deleted === 0) {
			console.log(chalk.dim("No matching grievances to delete."));
			return;
		}

		const scope =
			options.id !== undefined ? `#${options.id}` : options.tool ? `for ${options.tool}` : "(all entries)";
		console.log(chalk.green(`Deleted ${formatCount("grievance", deleted)} ${scope}.`));
	} finally {
		db.close();
	}
}

interface ProgressBar {
	update(done: number): void;
	finish(): void;
}

function makeProgressBar(total: number, width = 30): ProgressBar {
	const isTty = !!process.stdout.isTTY;
	if (!isTty || total === 0) {
		return { update: () => undefined, finish: () => undefined };
	}
	const render = (done: number): void => {
		const ratio = Math.min(1, done / total);
		const bar = subCellBar(ratio, width);
		const pct = `${Math.floor(ratio * 100)
			.toString()
			.padStart(3, " ")}%`;
		process.stdout.write(`\r${chalk.cyan("Pushing")} [${bar}] ${pct} ${done}/${total}`);
	};
	render(0);
	return {
		update: render,
		finish: () => process.stdout.write("\n"),
	};
}

export async function pushGrievances(options: PushGrievancesOptions): Promise<void> {
	const db = openAutoQaDb();
	if (!db) {
		const unavailable = grievanceDbUnavailable();
		if (options.json) {
			console.log(JSON.stringify({ pushed: 0, ok: false, skipped: true, reason: unavailable.reason }));
		}
		reportGrievanceDbUnavailable(options.json, unavailable);
		return;
	}
	const settings = await Settings.init();
	let bar: ProgressBar = { update: () => undefined, finish: () => undefined };
	let total = 0;

	try {
		const result = await flushGrievances(db, settings, {
			forceUpload: true,
			onStart: t => {
				total = t;
				if (!options.json) bar = makeProgressBar(t);
			},
			onProgress: pushed => bar.update(pushed),
		});
		bar.finish();

		if (options.json) {
			console.log(JSON.stringify(result));
			return;
		}

		if (result.skipped) {
			console.log(
				chalk.yellow(
					"Push skipped — no endpoint configured. Set `dev.autoqaPush.endpoint` or `VEYYON_AUTO_QA_PUSH_URL`.",
				),
			);
			return;
		}
		if (total === 0) {
			console.log(chalk.dim("Nothing to push — all grievances are already shipped."));
			return;
		}
		if (result.ok) {
			console.log(chalk.green(`Pushed ${result.pushed}/${total} ${pluralize("grievance", result.pushed)}.`));
			return;
		}
		const remaining = total - result.pushed;
		console.log(
			chalk.red(
				`Push failed after ${result.pushed}/${total}; ${formatCount("grievance", remaining)} remain unpushed.`,
			),
		);
		process.exitCode = 1;
	} finally {
		db.close();
	}
}
