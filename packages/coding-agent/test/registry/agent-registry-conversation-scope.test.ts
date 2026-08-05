/**
 * Conversation scoping in the agent registry.
 *
 * WHY IT EXISTS. The registry is process-global and outlives any single
 * transcript, so a session that re-roots (`/new`, `/resume`) used to leave the
 * previous conversation's subagents sitting in every roster the new one built:
 * `irc list` offered peers belonging to a transcript the user had already
 * replaced, and messaging one of them talked to an agent working from context
 * nobody in the new conversation shared. `AgentRef.scope` names the
 * conversation a spawn tree belongs to, and these tests pin the three parts
 * that make it work: derivation by LINEAGE (so a whole tree agrees on one
 * scope), a permissive comparison (so an unattributable ref stays visible
 * instead of emptying the roster), and filtering that drops only refs which
 * positively belong somewhere else.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type AgentRef, AgentRegistry, type RegistryEvent } from "@veyyon/coding-agent/registry/agent-registry";

let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
});

/** Ids only: the assertions are about which agents a roster names. */
function ids(refs: readonly AgentRef[]): string[] {
	return refs.map(ref => ref.id);
}

describe("Scope derivation at registration", () => {
	/**
	 * An explicit scope is the caller stating the SessionManager id it owns, and
	 * it must survive derivation. A `register` that recomputed scope from
	 * `sessionFile` would overwrite the id with a transcript path, and the path
	 * and the id are different strings for the same conversation, so nothing
	 * registered later under the id would match it.
	 */
	test("keeps the scope a main session states explicitly", () => {
		const ref = registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: "/transcripts/main.jsonl",
			scope: "session-a",
		});

		expect(ref.scope).toBe("session-a");
		expect(registry.get("Main")?.scope).toBe("session-a");
	});

	/**
	 * The fallback for a caller with no id to give: a root session's own
	 * transcript path names its conversation. Without it a `main` registered by
	 * an older call site would be unscoped, and every later ref would then match
	 * it permissively, which silently turns scoping off for that session.
	 */
	test("derives a main session's scope from its session file", () => {
		const ref = registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: "/transcripts/main.jsonl",
		});

		expect(ref.scope).toBe("/transcripts/main.jsonl");
	});

	/**
	 * A parentless subagent is left unattributed ON PURPOSE. Deriving a scope
	 * from its own transcript path would invent a name nothing else shares, and
	 * a positively-scoped ref matching no one is hidden from the roster that
	 * should be showing it. Unscoped keeps it visible.
	 */
	test("leaves a parentless subagent unscoped rather than naming it after its own file", () => {
		const ref = registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			sessionFile: "/transcripts/main/0-Sub.jsonl",
		});

		expect(ref.scope).toBeUndefined();
	});

	/**
	 * Derivation is by lineage, not by the agent's own transcript. A subagent
	 * writes its file inside its parent's directory, so its own path is a
	 * different string for the same conversation; taking the parent's scope is
	 * what makes a spawn tree one conversation.
	 */
	test("inherits the parent's scope for a subagent", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });

		const child = registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/transcripts/main/0-Sub.jsonl",
		});

		expect(child.scope).toBe("session-a");
	});

	/**
	 * Inheritance is transitive, which is the case that makes a whole spawn tree
	 * one conversation however deep it nests. A single-level derivation would
	 * leave a subagent's own subagent unscoped, and an unscoped ref matches every
	 * scope permissively, so the grandchild would show up in the OTHER
	 * conversation's roster: the exact leak scoping exists to close.
	 */
	test("inherits the root scope through two levels of spawning", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", parentId: "Main", session: null });

		const grandchild = registry.register({
			id: "0-0-Sub",
			displayName: "scout",
			kind: "sub",
			parentId: "0-Sub",
			session: null,
		});

		expect(grandchild.scope).toBe("session-a");
	});
});

describe("Scope comparison", () => {
	/**
	 * Permissive by design, and asserted in all four combinations because the
	 * asymmetric ones are where a plain `a === b` would go wrong. A filter that
	 * hid what it could not attribute would empty the roster of a collab guest,
	 * whose refs are mirrored from the host and carry no local scope, and of
	 * every render-only caller that registers no scope at all.
	 */
	test("treats an unknown scope on either side as visible and only rejects two different known scopes", () => {
		expect(AgentRegistry.sameScope(undefined, undefined)).toBe(true);
		expect(AgentRegistry.sameScope(undefined, "session-a")).toBe(true);
		expect(AgentRegistry.sameScope("session-a", undefined)).toBe(true);
		expect(AgentRegistry.sameScope("session-a", "session-a")).toBe(true);
		expect(AgentRegistry.sameScope("session-a", "session-b")).toBe(false);
	});
});

describe("listInScope", () => {
	/**
	 * The roster a surface renders on behalf of one conversation: its own agents
	 * plus the unattributable ones, and nothing that positively belongs to
	 * another conversation. Asserted as an exact id list, because a count would
	 * pass for a filter that dropped the right number of the wrong rows.
	 */
	test("names this conversation's agents and the unscoped ones, never another conversation's", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Guest", displayName: "guest", kind: "sub", session: null });
		registry.register({ id: "Other-Main", displayName: "main", kind: "main", session: null, scope: "session-b" });
		registry.register({
			id: "Other-Sub",
			displayName: "scout",
			kind: "sub",
			parentId: "Other-Main",
			session: null,
		});

		expect(ids(registry.listInScope("session-a"))).toEqual(["Main", "0-Sub", "Guest"]);
		expect(ids(registry.listInScope("session-b"))).toEqual(["Guest", "Other-Main", "Other-Sub"]);
	});

	/** An unscoped caller sees everything, which is what keeps a render-only surface working. */
	test("names every agent when the caller states no scope", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "Other-Main", displayName: "main", kind: "main", session: null, scope: "session-b" });

		expect(ids(registry.listInScope(undefined))).toEqual(["Main", "Other-Main"]);
	});
});

describe("listVisibleTo", () => {
	/**
	 * THE headline case. Two driving sessions, each with its own subagent: the
	 * peer roster of one must not name the other conversation's subagent, or
	 * `irc list` offers a peer that is working from context this conversation
	 * never had, and a DM to it lands in a transcript the user already replaced.
	 */
	test("does not name another conversation's subagent as a peer", () => {
		registry.register({ id: "Main-A", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "Sub-A", displayName: "reviewer", kind: "sub", parentId: "Main-A", session: null });
		registry.register({ id: "Main-B", displayName: "main", kind: "main", session: null, scope: "session-b" });
		registry.register({ id: "Sub-B", displayName: "scout", kind: "sub", parentId: "Main-B", session: null });

		expect(ids(registry.listVisibleTo("Main-A"))).toEqual(["Sub-A"]);
		expect(ids(registry.listVisibleTo("Main-B"))).toEqual(["Sub-B"]);
	});

	/**
	 * Scoping is added to the existing rules, not substituted for them. A peer
	 * roster that started naming the caller, an advisor transcript, or a parked
	 * or hard-killed agent would offer addresses that cannot answer.
	 */
	test("still excludes the caller, advisors, and agents that are parked or aborted", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "Live", displayName: "reviewer", kind: "sub", parentId: "Main", session: null });
		registry.register({
			id: "Advisor",
			displayName: "critic",
			kind: "advisor",
			parentId: "Main",
			session: null,
		});
		registry.register({
			id: "Parked",
			displayName: "scout",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "Aborted",
			displayName: "scout",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "aborted",
		});

		expect(ids(registry.listVisibleTo("Main"))).toEqual(["Live"]);
	});

	/** Flat within a conversation: a grandchild is a peer of the root, at any depth. */
	test("names a grandchild of the caller's own conversation", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "Sub", displayName: "reviewer", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Grandchild", displayName: "scout", kind: "sub", parentId: "Sub", session: null });

		expect(ids(registry.listVisibleTo("Main"))).toEqual(["Sub", "Grandchild"]);
	});
});

describe("rescope", () => {
	/**
	 * Only the named ref moves. Its former children belong to the conversation
	 * that just ended and the caller re-rooting the session is expected to
	 * release them; a `rescope` that walked descendants would instead adopt any
	 * survivor into the new conversation, which is the leak in reverse.
	 */
	test("moves only the named agent and leaves its children on the old scope", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		registry.register({ id: "Sub", displayName: "reviewer", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Grandchild", displayName: "scout", kind: "sub", parentId: "Sub", session: null });

		registry.rescope("Main", "session-b");

		expect(registry.get("Main")?.scope).toBe("session-b");
		expect(registry.get("Sub")?.scope).toBe("session-a");
		expect(registry.get("Grandchild")?.scope).toBe("session-a");
		expect(ids(registry.listInScope("session-b"))).toEqual(["Main"]);
	});

	/**
	 * A re-scope changes what every roster should show, so it must reach the
	 * surfaces watching the registry. Without the event the Control Center keeps
	 * rendering the roster of the conversation the session just left until some
	 * unrelated status change happens to repaint it.
	 */
	test("tells registry listeners the ref changed", () => {
		registry.register({ id: "Main", displayName: "main", kind: "main", session: null, scope: "session-a" });
		const events: RegistryEvent[] = [];
		const unsubscribe = registry.onChange(event => events.push(event));

		registry.rescope("Main", "session-b");
		unsubscribe();

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("status_changed");
		expect(events[0]?.ref.id).toBe("Main");
		expect(events[0]?.ref.scope).toBe("session-b");
	});
});
