/**
 * Holds on a session-created MCP manager, so the servers stay connected while any top-level
 * session that uses them is live and disconnect when the last one disposes.
 *
 * The session that creates a manager takes the first hold. A later top-level session in the same
 * process that is handed the manager (the `/new` that keeps the previous conversation running)
 * takes another. A manager the caller created and passed in has no holds, so no session
 * disconnects it; its creator does.
 */

import type { MCPManager } from "./manager";

const holds = new WeakMap<MCPManager, number>();

/** A release that ends one hold. Calling it again does nothing. */
export type McpManagerRelease = () => Promise<void>;

function releaseOnce(manager: MCPManager): McpManagerRelease {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		const remaining = (holds.get(manager) ?? 1) - 1;
		if (remaining > 0) {
			holds.set(manager, remaining);
			return;
		}
		holds.delete(manager);
		await manager.disconnectAll();
	};
}

/** Take the first hold on a manager this session created. */
export function holdCreatedMcpManager(manager: MCPManager): McpManagerRelease {
	holds.set(manager, (holds.get(manager) ?? 0) + 1);
	return releaseOnce(manager);
}

/**
 * Take a hold on a manager another session created, or `undefined` when the manager has no holds:
 * it belongs to whoever passed it in, or every holder already released it.
 */
export function holdSharedMcpManager(manager: MCPManager): McpManagerRelease | undefined {
	const current = holds.get(manager);
	if (current === undefined) return undefined;
	holds.set(manager, current + 1);
	return releaseOnce(manager);
}

/**
 * The hold a session takes on its MCP manager. A session holds a manager it created, and a top-level
 * session holds one handed down by the session that created it (the `/new` that keeps the previous
 * conversation running). A spawned agent holds nothing and never disconnects its parent's manager.
 */
export function holdSessionMcpManager(
	manager: MCPManager,
	handedDown: MCPManager | undefined,
	isSpawned: boolean,
): McpManagerRelease | undefined {
	if (!handedDown) return holdCreatedMcpManager(manager);
	return isSpawned ? undefined : holdSharedMcpManager(manager);
}
