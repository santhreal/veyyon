/**
 * The wire the desktop client speaks. Every type and runtime array a frame is
 * made of is generated from the Rust model in `crates/veyyon-desktop-model` into
 * `wire.generated.ts`, and
 * `crates/veyyon-desktop-model/tests/the_typescript_wire_is_generated_from_the_rust_types.rs`
 * fails when that file differs from what the Rust types produce.
 *
 * Serde's external tagging is the encoding: a unit variant is its name as a
 * string, a struct variant is `{ Name: {...} }`.
 * `crates/veyyon-desktop-model/tests/fixtures/snapshot-sections.json` holds one
 * instance of every section; both sides read it, so a `#[ts(type)]` override
 * that names the wrong shape fails the Rust deserialization test or the
 * TypeScript assignment in
 * `test/gui-host/every-snapshot-section-is-one-the-desktop-decodes.test.ts`.
 *
 * This module adds what the host needs beyond the frames themselves.
 */
import type { SnapshotSection, SnapshotSectionTag } from "./wire.generated";

export * from "./wire.generated";

/**
 * The `response` of `RespondToInteraction`, by the kind of decision it answers.
 * The Rust model holds it as an opaque JSON value; the host reads these shapes.
 * An approval's `scope` defaults to `"once"`; `"session"` stands for the rest
 * of the session, the same grant the terminal's "for session" rows record. A
 * plan sent back for revision carries the refinement asked for in `feedback`,
 * which is empty when the answer came from the card's own row.
 */
export type InteractionResponse =
	| { approved: boolean; scope?: "once" | "session" }
	| { option: number }
	| { text: string }
	| { accepted: boolean; feedback?: string };

/** The one tag a section carries; `keyof` a union member is its tag. */
export function getSnapshotSectionTag(section: SnapshotSection): SnapshotSectionTag {
	return Object.keys(section)[0] as SnapshotSectionTag;
}

/**
 * Extract the action tag name from the `action` of a request frame, which has
 * not been checked against `HostAction` when this runs.
 */
export function getActionTag(action: unknown): string {
	if (typeof action === "string") {
		return action;
	}
	if (action && typeof action === "object") {
		const keys = Object.keys(action);
		if (keys.length > 0) {
			return keys[0];
		}
	}
	return String(action);
}

/**
 * Extract the section name a snapshot frame carries, for the message a
 * request states when its view could not be sent.
 */
export function snapshotSectionTag(section: SnapshotSection): string {
	return Object.keys(section)[0] ?? "unknown";
}
