import { describe, expect, it } from "bun:test";
import type { CollabGuestLink } from "@veyyon/coding-agent/collab/guest";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "@veyyon/coding-agent/collab/guest-commands";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * WHY: `COLLAB_GUEST_ALLOWED_COMMANDS` listed `theme`, and no `/theme` builtin exists — the
 * dispatcher keys the allowlist on `command.name` after registry lookup, so the entry could never
 * be reached. A dead entry in a security-shaped allowlist is worse than useless: it reads as a
 * granted permission and hides that the real surface is smaller than the list claims.
 *
 * The class this closes is "an allowlist that names something the registry does not have", in both
 * directions of drift: renaming a command silently revokes a guest's permission, and typing a new
 * entry silently grants nothing. Both are caught here because the key set is compared against the
 * canonical names the dispatcher actually looks up, enumerated from the registry at run time.
 *
 * It also pins the default: every registered command that is NOT allowlisted refuses a guest with
 * the host-only status and never reaches its handler, so a new command is host-only until someone
 * writes it into the allowlist on purpose.
 *
 * What it does not catch: whether an allowlisted command is SAFE for a guest to run (that it only
 * reads local state). It proves the gate lets it through, not that letting it through is right.
 */

const CANONICAL_NAMES = new Set(BUILTIN_SLASH_COMMAND_DEFS.map(command => command.name));
const ALLOWED = Object.keys(COLLAB_GUEST_ALLOWED_COMMANDS).sort();
const HOST_ONLY = BUILTIN_SLASH_COMMAND_DEFS.map(command => command.name)
	.filter(name => COLLAB_GUEST_ALLOWED_COMMANDS[name] !== true)
	.sort();

/** Truthy stands in for the link: the gate only tests presence. */
const GUEST_LINK = {} as unknown as CollabGuestLink;

interface Probe {
	statuses: string[];
	editorText: string[];
	runtime: TuiSlashCommandRuntime;
}

/**
 * A guest context that can be refused and can do nothing else.
 *
 * The gate reads `collabGuest`, `showStatus` and `editor`; everything else throws by name, so a
 * command that slips past the gate fails saying which member its handler reached rather than
 * quietly passing.
 */
function guestProbe(): Probe {
	const statuses: string[] = [];
	const editorText: string[] = [];
	const members: Record<string, unknown> = {
		collabGuest: GUEST_LINK,
		showStatus: (text: string) => statuses.push(text),
		editor: { setText: (text: string) => editorText.push(text) },
		ui: { requestRender: () => {} },
	};
	const ctx = new Proxy(members, {
		get(target, property) {
			if (typeof property !== "string") return undefined;
			if (!(property in target)) {
				throw new Error(`guest invocation reached ctx.${property}: the host-only gate did not refuse`);
			}
			return target[property];
		},
	}) as unknown as InteractiveModeContext;
	return { statuses, editorText, runtime: { ctx } };
}

describe("a collab guest runs only commands that exist", () => {
	it("the registry and the allowlist are both alive", () => {
		expect(CANONICAL_NAMES.size).toBeGreaterThan(30);
		expect(ALLOWED.length).toBeGreaterThan(5);
	});

	/**
	 * Fail-by-default on drift: a typo, a rename, or an alias written where a canonical name
	 * belongs turns this red and names the entry. The opt-out set is pinned by exact equality so a
	 * second dead entry cannot join a counted allowance.
	 */
	it("every allowlisted name is a canonical command the dispatcher can look up", () => {
		const dead = ALLOWED.filter(name => !CANONICAL_NAMES.has(name));
		expect(dead).toEqual([]);
	});

	it.each(HOST_ONLY.map(name => [name] as const))(
		"/%s is refused for a guest and never reaches its handler",
		async name => {
			const probe = guestProbe();

			const handled = await executeBuiltinSlashCommand(`/${name}`, probe.runtime);

			expect(handled).toBe(true);
			expect(probe.statuses).toEqual([`/${name} is host-only during a collab session`]);
			expect(probe.editorText).toEqual([""]);
		},
	);

	it.each(ALLOWED.map(name => [name] as const))("/%s is not refused for a guest", async name => {
		const probe = guestProbe();

		// The handler runs for real past the gate and may reach a forbidden ctx member or need a
		// session; either is fine here. The contract under test is that the refusal did not fire.
		await executeBuiltinSlashCommand(`/${name}`, probe.runtime).catch(() => {});

		expect(probe.statuses).not.toContain(`/${name} is host-only during a collab session`);
	});
});
