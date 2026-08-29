import { prompt } from "@veyyon/utils";
import { type } from "arktype";
import type { SSHHost } from "../capability/ssh";
import { sshCapability } from "../capability/ssh";
import { loadCapability } from "../discovery";
import { toolsPrompts } from "../prompts/tools/rows";
import type { SSHHostInfo } from "../ssh/connection-manager";
import { getCachedHostInfoSync } from "../ssh/connection-manager";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { describeTimeoutParam } from "./tool-timeouts";

export const sshSchema = type({
	host: type("string").describe("ssh host"),
	command: type("string").describe("remote command"),
	"cwd?": type("string").describe("remote working directory; omit unless required, never ~ or ~/..."),
	"timeout?": type("number").describe(describeTimeoutParam("ssh")),
});

export interface SSHToolDetails {
	meta?: OutputMeta;
}

export function formatHostEntry(host: SSHHost): string {
	const info = getCachedHostInfoSync(host);

	let shell: string;
	if (!info) {
		shell = "detecting...";
	} else if (info.os === "windows") {
		if (info.compatEnabled) {
			const compatShell = info.compatShell || "bash";
			shell = `windows/${compatShell}`;
		} else if (info.shell === "powershell") {
			shell = "windows/powershell";
		} else {
			shell = "windows/cmd";
		}
	} else if (info.os === "linux") {
		shell = `linux/${info.shell}`;
	} else if (info.os === "macos") {
		shell = `macos/${info.shell}`;
	} else {
		shell = `unknown/${info.shell}`;
	}

	return `- ${host.name} (${host.host}) | ${shell}`;
}

export function formatDescription(hosts: SSHHost[]): string {
	const baseDescription = prompt.render(toolsPrompts["tools/ssh"].text);
	if (hosts.length === 0) {
		return baseDescription;
	}
	const hostList = hosts.map(formatHostEntry).join("\n");
	return `${baseDescription}\n\nAvailable hosts:\n${hostList}`;
}

export function quoteRemotePath(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	const escaped = value.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

export function quotePowerShellPath(value: string): string {
	if (value.length === 0) {
		return "''";
	}
	const escaped = value.replace(/'/g, "''");
	return `'${escaped}'`;
}

export function quoteCmdPath(value: string): string {
	const escaped = value.replace(/"/g, '""');
	return `"${escaped}"`;
}
export function assertValidSshCwd(cwd: string | undefined): void {
	if (!cwd) return;
	if (cwd === "~" || cwd.startsWith("~/")) {
		throw new ToolError("SSH cwd must be an absolute remote path; omit cwd instead of using ~.");
	}
}

export function buildRemoteCommand(command: string, cwd: string | undefined, info: SSHHostInfo): string {
	if (!cwd) return command;

	if (info.os === "windows" && !info.compatEnabled) {
		if (info.shell === "powershell") {
			return `Set-Location -Path ${quotePowerShellPath(cwd)}; ${command}`;
		}
		return `cd /d ${quoteCmdPath(cwd)} && ${command}`;
	}

	return `cd -- ${quoteRemotePath(cwd)} && ${command}`;
}

export async function loadHosts(session: ToolSession): Promise<{
	hostNames: string[];
	hostsByName: Map<string, SSHHost>;
}> {
	const result = await loadCapability<SSHHost>(sshCapability.id, {
		cwd: session.cwd,
		agentDir: session.settings.getAgentDir(),
	});
	const hostsByName = new Map<string, SSHHost>();
	for (const host of result.items) {
		if (!hostsByName.has(host.name)) {
			hostsByName.set(host.name, host);
		}
	}
	const hostNames = Array.from(hostsByName.keys()).sort();
	return { hostNames, hostsByName };
}

export type SshToolParams = typeof sshSchema.infer;
