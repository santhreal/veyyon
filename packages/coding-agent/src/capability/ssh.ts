import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface SSHHost {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
	_source: SourceMeta;
}

export const sshCapability = defineCapability<SSHHost>({
	id: "ssh",
	displayName: "SSH Hosts",
	description: "SSH host entries for remote command execution",
	key: host => host.name,
	validate: host => {
		if (!host.name) return "Missing name";
		if (!host.host) return "Missing host";
		return undefined;
	},
});
