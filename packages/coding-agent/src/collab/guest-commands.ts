/**
 * Which slash commands a collab guest may run locally.
 *
 * A leaf: the command dispatcher consults this table on every command, in a
 * synchronous path, and a session that never joins a collab room must not
 * evaluate the guest client (its relay socket, crypto and protocol codecs) to
 * read it.
 */

/** Commands a guest may run locally; everything else is host-only. */
export const COLLAB_GUEST_ALLOWED_COMMANDS: Record<string, true> = {
	dump: true,
	export: true,
	copy: true,
	welcome: true, // `/help` is an alias of `/welcome`; the gate keys on the canonical name
	hotkeys: true,
	settings: true,
	leave: true,
	collab: true,
	exit: true,
	quit: true,
};
