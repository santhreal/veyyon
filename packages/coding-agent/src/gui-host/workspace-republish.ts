import type * as net from "node:net";
import { errorMessage, logger } from "@veyyon/utils";
import { daemonClientForProject } from "../launch/client";
import { changesView } from "./actions/changes";
import { usageView } from "./actions/diagnostics";
import { fileTreeView } from "./actions/files";
import { mapProcessesView } from "./actions/process-session";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";

/**
 * Re-state every domain a turn changes, once the agent has gone idle.
 *
 * The host publishes these domains only when a client asks for them, and the
 * desktop asks once, at the handshake. A turn that edits a file, creates one,
 * launches a process or spends a token therefore leaves the panel drawing the
 * workspace as it stood when the session opened: the Changes tab lists the
 * files the agent touched before the turn and not the ones it touched during
 * it, and a file the agent created never reaches the open tree.
 *
 * What is re-stated is what a turn can change:
 *
 * - `Changes`, because the agent edits files.
 * - `FileTree`, when this client has loaded one, because the agent creates and
 *   deletes them. A client that never loaded a tree is sent none.
 * - `Usage`, because the turn spent tokens.
 * - `Processes`, when this client has been sent the list, because the agent
 *   launches them. Answering that request is what starts the project's
 *   supervisor, so re-stating it unasked would start a broker behind every
 *   workspace that supervises nothing.
 *
 * `Diagnostics` is not here: it reports host health and MCP server status,
 * neither of which a turn changes.
 *
 * The domains are published in one order, and the totals are published last:
 * a client that reads them knows the re-statement is complete, and nothing
 * has to guess whether a domain it did not receive is still coming.
 *
 * Each domain is published on its own, so one that fails leaves the others
 * stated rather than taking the re-statement down with it. A failure is
 * logged and never reaches the client as a request failure: no request asked
 * for this.
 */
export async function republishWorkspace(socket: net.Socket, state: ClientSessionState, cwd: string): Promise<void> {
	if (socket.destroyed) return;

	await publish("Changes", async () => {
		writeFrame(socket, { Snapshot: { Changes: await changesView(cwd, state) } });
	});
	await publish("FileTree", async () => {
		const root = state.fileTreeRoot;
		if (!root) return;
		writeFrame(socket, { Snapshot: { FileTree: await fileTreeView(cwd, root) } });
	});
	await publish("Processes", async () => {
		if (!state.processesListed) return;
		const client = await daemonClientForProject(cwd);
		const processes = await mapProcessesView(cwd, client);
		state.revision += 1;
		writeFrame(socket, { Snapshot: { Processes: processes } });
	});
	await publish("Usage", async () => {
		const session = state.agentSession;
		if (!session) return;
		state.revision += 1;
		writeFrame(socket, { Snapshot: { Usage: usageView(session) } });
	});
}

async function publish(domain: string, write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch (error) {
		logger.debug("GUI host could not re-state a workspace domain", { domain, error: errorMessage(error) });
	}
}
