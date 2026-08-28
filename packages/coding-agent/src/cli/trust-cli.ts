/** The operator's side of project trust: see what a repository wants to run, and decide. withheld, so the decision is never racing a side effect. That ordering is the safety property, */
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
	/** Paths named on the command line; empty means "everything discovered". */
	paths: readonly string[];
}

export interface TrustCandidate {
	relativePath: string;
	absolutePath: string;
	verdict: ProjectTrustVerdict;
	/** What this file grants, in the operator's terms. */
	grants: string;
}

export interface TrustCommandResult {
	action: TrustAction;
	projectRoot: string;
	storePath: string;
	decision: "trusted" | "denied" | "undecided";
	candidates: TrustCandidate[];
	/** Paths the caller named that are not inside the project root. */
	outOfScope: string[];
	/** Paths the caller named that do not exist or cannot be read. */
	unreadable: string[];
}

/** Every project-controlled file that grants execution, whether or not it is decided. Discovery is deliberately narrow: this lists the doors, not everything behind them. The plugin */
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
		// describeProjectExecutable folds "outside the project" and "cannot be read" into one null, and the operator's next move differs: one is the wrong directory, the other is a
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

/** The report an operator reads. One line per file, decision first. */
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

/** The `/trust` verb, for a session that is already running. Same authority and same report as the CLI command; only the parsing differs, because a slash */
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
	// A decision changes what discovery may read, and plugin roots are cached for the life of the
	// process; without this the operator would have to restart to see their own answer take effect.
	if (action !== "list") clearClaudePluginRootsCache();
	return renderTrustReport(result);
}
