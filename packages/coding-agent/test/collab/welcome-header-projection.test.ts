/**
 * What the host's session header looks like by the time a guest receives it.
 *
 * WHY THIS SUITE EXISTS. The `welcome` frame's `header` used to be typed as the host's own
 * `SessionHeader` and filled with `snapshot.header` verbatim. That typechecked against the
 * wire contract, because assignability runs the permissive way: a header carrying MORE
 * fields still satisfies a type declaring four. So three fields the wire contract does not
 * declare went to every guest, including read-only viewers who joined through a view link:
 * `titleSource`, `parentSession`, and `providerPromptCacheKey`.
 *
 * The last one is the reason this is a defect and not untidiness. `providerPromptCacheKey`
 * is the provider prompt-cache identity a fork inherits so it can stay on the same cached
 * prefix, and the guest does not merely read the header it received: `guest.ts` writes it
 * as the first line of its own replica session file. So the host's cache identity and the
 * id of the session it was forked from were being persisted on other people's machines, by
 * a frame nobody had to change for it to happen.
 *
 * The fix is a projection the compiler enforces, and these tests pin both halves of it:
 * the four declared fields are carried through exactly, and every host-only field is gone.
 * The projection is written out field by field rather than as a destructuring rest, so the
 * last test here is the one that matters over time -- a field added to the host's header
 * must not start shipping on its own.
 */

import { describe, expect, it } from "bun:test";
import { toWireSessionHeader } from "@veyyon/coding-agent/collab/protocol";
import type { SessionHeader } from "@veyyon/coding-agent/session/session-entries";

/** A host header with every field the host's own type declares populated. */
function fullHostHeader(): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: "01JZQ4VN2M7X8P0R5T9K3B6C2D",
		title: "wire up the relay",
		titleSource: "auto",
		timestamp: "2026-07-25T09:14:22.481Z",
		cwd: "/srv/project",
		parentSession: "01JZQ0AAAAAAAAAAAAAAAAAAAA",
		providerPromptCacheKey: "anthropic:cache-prefix-9f2c1d",
	};
}

describe("projecting the host session header onto the wire shape", () => {
	/**
	 * The four declared fields survive byte for byte. A projection that dropped one would
	 * make the guest's transcript header wrong in a way no type error could catch, since
	 * every one of them is optional-or-present rather than structurally required.
	 */
	it("carries every field the wire contract declares", () => {
		const wire = toWireSessionHeader(fullHostHeader());

		expect(wire.type).toBe("session");
		expect(wire.id).toBe("01JZQ4VN2M7X8P0R5T9K3B6C2D");
		expect(wire.title).toBe("wire up the relay");
		expect(wire.timestamp).toBe("2026-07-25T09:14:22.481Z");
		expect(wire.cwd).toBe("/srv/project");
	});

	/**
	 * THE LEAK. Asserted as the exact key set rather than field by field, so a field added
	 * to the host's header and passed through by accident fails here instead of shipping.
	 */
	it("drops every host-only field, checked as the whole key set", () => {
		const wire = toWireSessionHeader(fullHostHeader());

		expect(Object.keys(wire).sort()).toEqual(["cwd", "id", "timestamp", "title", "type"]);
	});

	/**
	 * The three fields by name, because a key-set assertion says WHICH keys are allowed
	 * while this says which ones were the bug. `providerPromptCacheKey` is the one that
	 * reached other people's disks.
	 */
	it.each(["titleSource", "parentSession", "providerPromptCacheKey", "version"])(
		"does not send the host-only field %s",
		field => {
			const wire = toWireSessionHeader(fullHostHeader()) as unknown as Record<string, unknown>;

			expect(field in wire).toBe(false);
		},
	);

	/**
	 * A v1 session has no `version` and no title, and the projection must not invent either.
	 * `title` is declared optional on the wire type, so `undefined` is the honest answer;
	 * what would be wrong is an empty string, which a guest would render as a named session.
	 */
	it("leaves an absent title absent rather than inventing an empty one", () => {
		const v1: SessionHeader = {
			type: "session",
			id: "01JZQ4VN2M7X8P0R5T9K3B6C2D",
			timestamp: "2026-07-25T09:14:22.481Z",
			cwd: "/srv/project",
		};

		const wire = toWireSessionHeader(v1);

		expect(wire.title).toBeUndefined();
		expect(JSON.parse(JSON.stringify(wire))).toEqual({
			type: "session",
			id: "01JZQ4VN2M7X8P0R5T9K3B6C2D",
			timestamp: "2026-07-25T09:14:22.481Z",
			cwd: "/srv/project",
		});
	});

	/**
	 * The projection copies rather than aliases. The header it is handed is the LIVE one the
	 * session manager keeps (`snapshotForReplication` returns it by reference), so a frame
	 * holding the same object would let a later host-side title change mutate a payload that
	 * has already been described to a guest, and would let a guest-bound value be reachable
	 * from host state.
	 */
	it("returns a new object rather than the live header", () => {
		const host = fullHostHeader();
		const wire = toWireSessionHeader(host);

		expect(wire).not.toBe(host);
		host.title = "renamed after the frame was built";
		expect(wire.title).toBe("wire up the relay");
	});

	/**
	 * Serializing the result is what actually travels, so assert on the JSON rather than the
	 * object: this is the byte-level statement that nothing host-only crosses the relay.
	 */
	it("serializes to exactly the declared fields", () => {
		const json = JSON.stringify(toWireSessionHeader(fullHostHeader()));

		expect(json).toBe(
			'{"type":"session","id":"01JZQ4VN2M7X8P0R5T9K3B6C2D","title":"wire up the relay","timestamp":"2026-07-25T09:14:22.481Z","cwd":"/srv/project"}',
		);
		expect(json).not.toContain("cache-prefix");
	});
});
