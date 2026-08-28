import * as fs from "node:fs";
import * as path from "node:path";
import { $which, APP_NAME, VERSION } from "@veyyon/utils";
import { completionEnvFrom, completionTargets } from "./completion-refresh";
import { probeSearchWorks, resolveUpdateMethod, verifyBinaryVersion, windowsCompletionTargets } from "./update-cli";

export interface CompletionFile {
	shell: string;
	filePath: string;
}

export interface InstallHealthCheck {
	name: string;
	status: "ok" | "warning" | "error";
	message: string;
}

const ALIAS_NAME = "vey";

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

export interface InstallHealthDeps {
	resolveBinary?: () => string | undefined;
	resolveAlias?: () => string | undefined;
	pathValue?: string | undefined;
	exists?: (filePath: string) => boolean;
	version?: string;
	verifyVersion?: typeof verifyBinaryVersion;
	probeSearch?: typeof probeSearchWorks;
	env?: Record<string, string | undefined>;
	completionFiles?: () => Promise<CompletionFile[]> | CompletionFile[];
}

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
