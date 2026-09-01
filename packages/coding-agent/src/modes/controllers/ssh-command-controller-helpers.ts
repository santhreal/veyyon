import type { InteractiveModeContext } from "../types";

export const SSH_ADD_USAGE =
	"Usage: /ssh add <name> <host> [user <user>] [<port>] [key <keyPath>] [desc <description>] [compat]";

export const SSH_REMOVE_USAGE = "Usage: /ssh remove <name>";

export const SSH_ADD_REMOVED_OPTIONS: Record<string, string> = {
	host: "write the host as the second word, after the name",
	user: "write `user <user>`",
	port: "write the port as a plain integer",
	key: "write `key <keyPath>`",
	desc: "write `desc <description>`",
	compat: "write `compat` as a plain word",
};

export const SSH_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: "drop it — SSH hosts live in one config file, so there is no scope to choose",
};

export type SshAddParsed = {
	name?: string;
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
	error?: string;
};

export type SshCommandControllerContext = Pick<InteractiveModeContext, "present" | "session" | "showError">;
