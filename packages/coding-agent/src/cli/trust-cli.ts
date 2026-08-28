import * as path from "node:path";
import { pathExists } from "@veyyon/utils";
import { clearClaudePluginRootsCache, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import {
	canonicalProjectRoot,
	describeProjectExecutable,
	type ProjectExecutable,
	ProjectTrust,
	type ProjectTrustVerdict,
} from "../security/project-trust";

export type TrustAction = "approve" | "deny" | "forget" | "list";

export interface TrustCommandArgs {
	cwd: string;
	agentDir: string;
	action: TrustAction;
	paths: readonly string[];
}

export interface TrustCandidate {
	relativePath: string;
	absolutePath: string;
	verdict: ProjectTrustVerdict;
	grants: string;
}

export interface TrustCommandResult {
	action: TrustAction;
	projectRoot: string;
	storePath: string;
	decision: "trusted" | "denied" | "undecided";
	candidates: TrustCandidate[];
	outOfScope: string[];
	unreadable: string[];
}

async function discoverCandidatePaths(cwd: string): Promise<string[]> {
	const registry = await resolveActiveProjectRegistryPath(cwd);
	return registry ? [registry] : [];
}

function grantsFor(relativePath: string): string {
	return relativePath.endsWith("installed_plugins.json")
		? "plugins: extensions, hooks, custom tools, slash commands and MCP servers"
		: "code loaded at startup";
}

export async function runTrustCommand(args: TrustCommandArgs): Promise<TrustCommandResult> {
	const projectRoot = await canonicalProjectRoot(args.cwd);
	const trust = await ProjectTrust.load(args.agentDir);

	const named = args.paths.map(p => path.resolve(args.cwd, p));
	const discovered = named.length > 0 ? named : await discoverCandidatePaths(args.cwd);

	const outOfScope: string[] = [];
	const unreadable: string[] = [];
	const executables: ProjectExecutable[] = [];
	for (const absolutePath of discovered) {
		const executable = await describeProjectExecutable(absolutePath, projectRoot);
		if (executable) {
			executables.push(executable);
			continue;
		}
		if (await pathExists(absolutePath, "a path named for a trust decision")) outOfScope.push(absolutePath);
		else unreadable.push(absolutePath);
	}

	if (args.action === "approve" && executables.length > 0) await trust.trust(projectRoot, executables);
	if (args.action === "deny") await trust.deny(projectRoot);
	if (args.action === "forget") await trust.forget(projectRoot);

	const record = trust.recordFor(projectRoot);
	const candidates = executables.map(executable => ({
		relativePath: executable.relativePath,
		absolutePath: executable.absolutePath,
		verdict: trust.evaluate(projectRoot, executable),
		grants: grantsFor(executable.relativePath),
	}));

	return {
		action: args.action,
		projectRoot,
		storePath: trust.filePath,
		decision: record?.decision ?? "undecided",
		candidates,
		outOfScope,
		unreadable,
	};
}

export function renderTrustReport(result: TrustCommandResult): string {
	const lines: string[] = [];
	lines.push(`Project: ${result.projectRoot}`);
	lines.push(`Decision: ${result.decision}`);
	if (result.candidates.length === 0) {
		lines.push("No project-controlled executable files found.");
	}
	for (const candidate of result.candidates) {
		lines.push(`  ${candidate.verdict === "trusted" ? "trusted  " : "withheld "} ${candidate.relativePath}`);
		lines.push(`            grants ${candidate.grants}`);
	}
	for (const outside of result.outOfScope) {
		lines.push(`  skipped   ${outside}`);
		lines.push("            outside this project; nothing to decide (it is already yours)");
	}
	for (const missing of result.unreadable) {
		lines.push(`  missing   ${missing}`);
	}
	if (result.decision !== "trusted" && result.candidates.some(c => c.verdict !== "trusted")) {
		lines.push("");
		lines.push("Run `veyyon trust` in this directory to approve these exact files.");
	}
	lines.push("");
	lines.push(`Recorded in ${result.storePath}`);
	return `${lines.join("\n")}\n`;
}

export async function runTrustSlashCommand(args: string, agentDir: string, cwd: string): Promise<string> {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const verb = (words[0] ?? "").toLowerCase();
	const action: TrustAction | null =
		verb === "" || verb === "list"
			? "list"
			: verb === "approve" || verb === "deny" || verb === "forget"
				? verb
				: null;
	if (action === null) return `Unknown /trust verb "${verb}". Use approve, deny, forget, or nothing to report.\n`;
	const result = await runTrustCommand({ cwd, agentDir, action, paths: words.slice(1) });
	if (action !== "list") clearClaudePluginRootsCache();
	return renderTrustReport(result);
}
