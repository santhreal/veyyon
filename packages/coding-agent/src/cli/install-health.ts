/** Whether the veyyon on this machine is actually installed correctly. `install.sh` runs a doctor at the end of every install: the binary runs, it */
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, APP_NAME, VERSION } from "@veyyon/utils";
import { completionEnvFrom, completionTargets } from "./completion-refresh";
import { probeSearchWorks, resolveUpdateMethod, verifyBinaryVersion, windowsCompletionTargets } from "./update-cli";

/** One answer about the install. Same shape as the plugin manager's `DoctorCheck` and deliberately a separate */
/** One completion script the installer could have written, and the shell it is for. */
export interface CompletionFile {
	shell: string;
	filePath: string;
}

export interface InstallHealthCheck {
	name: string;
	status: "ok" | "warning" | "error";
	message: string;
}

/** The alias `install.sh` links beside the binary. */
const ALIAS_NAME = "vey";

/** Every directory on PATH that holds a `veyyon`, in PATH order. The first one is what the shell runs. A second one is the shadowing failure */
export function veyyonPathEntries(
	pathValue: string | undefined,
	exists: (filePath: string) => boolean = filePath => fs.existsSync(filePath),
): string[] {
	if (!pathValue) return [];
	const found: string[] = [];
	const seen = new Set<string>();
	for (const dir of pathValue.split(path.delimiter)) {
		if (dir === "" || seen.has(dir)) continue;
		seen.add(dir);
		for (const name of [APP_NAME, `${APP_NAME}.exe`, `${APP_NAME}.cmd`]) {
			if (exists(path.join(dir, name))) {
				found.push(path.join(dir, name));
				break;
			}
		}
	}
	return found;
}

/** Injectable seams, so every case below is reachable without a real install. */
export interface InstallHealthDeps {
	/** What PATH resolves `veyyon` to right now. */
	resolveBinary?: () => string | undefined;
	/** What PATH resolves the `vey` alias to. Separate seam, separate question. */
	resolveAlias?: () => string | undefined;
	/** The raw PATH, split to find copies that shadow each other. */
	pathValue?: string | undefined;
	/** Whether a file is on disk; the same seam `veyyonPathEntries` takes. */
	exists?: (filePath: string) => boolean;
	/** The version this build reports about itself. */
	version?: string;
	/** Runs the binary and reads back the version it prints. */
	verifyVersion?: typeof verifyBinaryVersion;
	/** Runs a real search through the binary to prove the native addon loaded. */
	probeSearch?: typeof probeSearchWorks;
	/** The environment that decides where completion files live. */
	env?: Record<string, string | undefined>;
	/** Every completion file the installer could have written on THIS platform. Windows has no directory a shell autoloads completions from, so the */
	completionFiles?: () => Promise<CompletionFile[]> | CompletionFile[];
}

/** Ask the install every question the installer's doctor asks, plus the two it cannot: is anything shadowing this binary, and do the completion files on disk */
export async function runInstallHealthChecks(deps: InstallHealthDeps = {}): Promise<InstallHealthCheck[]> {
	const resolveBinary = deps.resolveBinary ?? (() => $which(APP_NAME) ?? undefined);
	const resolveAlias = deps.resolveAlias ?? (() => $which(ALIAS_NAME) ?? undefined);
	const exists = deps.exists ?? ((filePath: string) => fs.existsSync(filePath));
	const version = deps.version ?? VERSION;
	const verifyVersion = deps.verifyVersion ?? verifyBinaryVersion;
	const probeSearch = deps.probeSearch ?? probeSearchWorks;
	const env = deps.env ?? process.env;
	const pathValue = deps.pathValue !== undefined ? deps.pathValue : env.PATH;

	const checks: InstallHealthCheck[] = [];
	const binaryPath = resolveBinary();

	if (!binaryPath) {
		// Everything below is a question about a specific file. Without one there is
		// nothing to ask, and inventing an answer would be worse than saying so.
		checks.push({
			name: `${APP_NAME} on PATH`,
			status: "error",
			message:
				`\`${APP_NAME}\` does not resolve on PATH, so the shell cannot run it. ` +
				`Re-run the installer, or add the directory holding it to PATH.`,
		});
		return checks;
	}

	checks.push({ name: `${APP_NAME} on PATH`, status: "ok", message: `Resolves to ${binaryPath}` });

	// Shadowing. Reported against the path PATH actually picked, because "there are
	// two" only matters when the one being run is not the one being updated.
	const entries = veyyonPathEntries(pathValue, exists);
	if (entries.length > 1) {
		checks.push({
			name: "PATH copies",
			status: "warning",
			message:
				`${entries.length} copies of \`${APP_NAME}\` are on PATH and the first one wins: ` +
				`${entries.join(", ")}. An update writes one of them, so the other can keep ` +
				`answering with an older version.`,
		});
	} else {
		checks.push({ name: "PATH copies", status: "ok", message: `One copy on PATH` });
	}

	// Does it run, and is it this build? A mismatch here is the shadowing case
	// above seen from the other side, so it is a warning rather than an error: the
	// file is fine, the PATH order is not.
	const verified = await verifyVersion(binaryPath, version);
	if (verified.reason) {
		checks.push({ name: `${APP_NAME} runs`, status: "error", message: verified.reason });
	} else if (!verified.ok) {
		checks.push({
			name: `${APP_NAME} runs`,
			status: "warning",
			message:
				`${binaryPath} reports ${verified.actual ?? "no version"}, but this process is ${version}. ` +
				`PATH is resolving a different install than the one running.`,
		});
	} else {
		checks.push({ name: `${APP_NAME} runs`, status: "ok", message: `Reports ${version}` });
	}

	// The check that catches a release built for the wrong platform: `--version` is
	// answered by the entry point alone and passes with no native addon at all.
	const searchFailure = await probeSearch(binaryPath, `${APP_NAME} at ${binaryPath}`);
	checks.push(
		searchFailure === undefined
			? { name: "Native addon", status: "ok", message: "A real search returned the expected match" }
			: { name: "Native addon", status: "error", message: searchFailure },
	);

	checks.push({
		name: "Install method",
		status: "ok",
		message:
			resolveUpdateMethod(binaryPath) === "source"
				? `Source checkout — \`${APP_NAME} update\` advances the checkout`
				: `Release binary — \`${APP_NAME} update\` swaps the binary`,
	});

	// The alias is the name the docs tell people to type, so an alias that is
	// missing or points somewhere else is a real failure of the documented flow.
	const aliasPath = resolveAlias();
	if (!aliasPath) {
		checks.push({
			name: `${ALIAS_NAME} alias`,
			status: "warning",
			message: `\`${ALIAS_NAME}\` is not on PATH. Launch with \`${APP_NAME}\`, or re-run the installer.`,
		});
	} else {
		checks.push({ name: `${ALIAS_NAME} alias`, status: "ok", message: `Resolves to ${aliasPath}` });
	}

	// Completions are the one part of an install that fails silently: nothing goes
	// wrong, Tab just stops offering anything, and there is no message anywhere.
	const completionFiles =
		deps.completionFiles ??
		(async () =>
			process.platform === "win32"
				? await windowsCompletionTargets()
				: completionTargets(completionEnvFrom(env), APP_NAME, ALIAS_NAME));
	const present = (await completionFiles()).filter(file => exists(file.filePath));
	if (present.length === 0) {
		checks.push({
			name: "Shell completions",
			status: "warning",
			message: `No completion files found. Re-run the installer to write them, or use \`${APP_NAME} completions\`.`,
		});
	} else {
		const shells = Array.from(new Set(present.map(file => file.shell))).sort();
		checks.push({
			name: "Shell completions",
			status: "ok",
			message: `${present.length} file(s) installed for ${shells.join(", ")}`,
		});
	}

	return checks;
}
