//! WHY THIS SUITE EXISTS
//!
//! `ContentBlock` declares fifteen variants and `MessageRole` twelve, but the
//! host fills neither union. Every producer in
//! `packages/coding-agent/src/gui-host/` was enumerated against a running host:
//! `mapContentBlocks`, `agentMessageToTranscriptEntry`,
//! `sessionEntryToTranscriptEntry` and `mapMessageRole` in `session-bridge.ts`
//! are all of them, and six block kinds plus four roles appear nowhere outside
//! their declaration in `wire.ts`. The front end therefore ships nine block
//! render paths, not fifteen.
//!
//! That measurement rots in two directions, and both are silent. A host release
//! that starts producing `Diff` would reach a renderer that was never written,
//! and the transcript would show nothing where a diff belongs. A host release
//! that stops producing `Thinking` would leave a render path nothing reaches,
//! and no count would move.
//!
//! THE CLASS THIS CLOSES: a divergence between the variants this client renders
//! and the variants the host emits, in either direction. The reachable and
//! unreachable sets are pinned by exact equality and partition the whole enum,
//! which is derived from source at run time through `strum::EnumIter`. A
//! sixteenth block kind belongs to neither set and turns this suite red until
//! somebody records which side it is on.
//!
//! WHAT IT DOES NOT CATCH: it cannot read the host. The pin is a record of a
//! measurement taken by hand, so a host that changes its producers fails this
//! suite only after the pin is re-measured against it. It also says nothing
//! about whether a reachable variant is rendered correctly, only that a render
//! path is owed for it.

use std::collections::BTreeSet;

use strum::IntoEnumIterator;
use veyyon_desktop_model::{BlockKind, MessageRole};

/// Block kinds no producer in the host constructs, so no render path is owed.
const UNREACHABLE_BLOCKS: [BlockKind; 6] = [
	BlockKind::RedactedThinking,
	BlockKind::Execution,
	BlockKind::FileMention,
	BlockKind::Diff,
	BlockKind::ModelChange,
	BlockKind::ThinkingChange,
];

/// Roles no producer in the host assigns.
const UNREACHABLE_ROLES: [MessageRole; 4] = [
	MessageRole::BashExecution,
	MessageRole::PythonExecution,
	MessageRole::FileMention,
	MessageRole::Unknown,
];

/// Block kinds the host constructs, each owing the transcript a render path.
const REACHABLE_BLOCKS: [BlockKind; 10] = [
	BlockKind::Text,
	BlockKind::Thinking,
	BlockKind::Image,
	BlockKind::Video,
	BlockKind::ToolCall,
	BlockKind::ToolResult,
	BlockKind::Summary,
	BlockKind::Lifecycle,
	BlockKind::Fallback,
	BlockKind::Unknown,
];

/// Roles the host assigns.
const REACHABLE_ROLES: [MessageRole; 8] = [
	MessageRole::User,
	MessageRole::Assistant,
	MessageRole::ToolResult,
	MessageRole::Developer,
	MessageRole::Custom,
	MessageRole::CompactionSummary,
	MessageRole::BranchSummary,
	MessageRole::Lifecycle,
];

fn set_of<T: Ord + Copy>(items: &[T]) -> BTreeSet<T> {
	items.iter().copied().collect()
}

#[test]
fn the_two_block_sets_partition_every_variant_the_enum_declares() {
	let declared: BTreeSet<BlockKind> = BlockKind::iter().collect();
	let reachable = set_of(&REACHABLE_BLOCKS);
	let unreachable = set_of(&UNREACHABLE_BLOCKS);

	let overlap: Vec<BlockKind> = reachable.intersection(&unreachable).copied().collect();
	assert!(
		overlap.is_empty(),
		"a block kind is pinned as both reachable and unreachable: {overlap:?}",
	);

	let covered: BTreeSet<BlockKind> = reachable.union(&unreachable).copied().collect();
	let unclassified: Vec<BlockKind> = declared.difference(&covered).copied().collect();
	assert!(
		unclassified.is_empty(),
		"ContentBlock grew {unclassified:?}. Measure whether the host produces it: add it to \
		 REACHABLE_BLOCKS and write its render path, or to UNREACHABLE_BLOCKS and say why.",
	);

	let stale: Vec<BlockKind> = covered.difference(&declared).copied().collect();
	assert!(stale.is_empty(), "these block kinds are pinned but no longer declared: {stale:?}");
}

#[test]
fn the_two_role_sets_partition_every_variant_the_enum_declares() {
	let declared: BTreeSet<MessageRole> = MessageRole::iter().collect();
	let reachable = set_of(&REACHABLE_ROLES);
	let unreachable = set_of(&UNREACHABLE_ROLES);

	let overlap: Vec<MessageRole> = reachable.intersection(&unreachable).copied().collect();
	assert!(overlap.is_empty(), "a role is pinned as both reachable and unreachable: {overlap:?}");

	let covered: BTreeSet<MessageRole> = reachable.union(&unreachable).copied().collect();
	let unclassified: Vec<MessageRole> = declared.difference(&covered).copied().collect();
	assert!(
		unclassified.is_empty(),
		"MessageRole grew {unclassified:?}. Measure whether the host assigns it, then pin it on the \
		 side the measurement puts it.",
	);

	let stale: Vec<MessageRole> = covered.difference(&declared).copied().collect();
	assert!(stale.is_empty(), "these roles are pinned but no longer declared: {stale:?}");
}

#[test]
fn the_unreachable_block_set_is_exactly_the_six_that_were_measured() {
	// Exact equality, not a count: a swap that trades one unreachable kind for
	// another keeps the length at six and would otherwise pass.
	assert_eq!(
		set_of(&UNREACHABLE_BLOCKS),
		BTreeSet::from([
			BlockKind::RedactedThinking,
			BlockKind::Execution,
			BlockKind::FileMention,
			BlockKind::Diff,
			BlockKind::ModelChange,
			BlockKind::ThinkingChange,
		]),
	);
}

#[test]
fn the_unreachable_role_set_is_exactly_the_four_that_were_measured() {
	assert_eq!(
		set_of(&UNREACHABLE_ROLES),
		BTreeSet::from([
			MessageRole::BashExecution,
			MessageRole::PythonExecution,
			MessageRole::FileMention,
			MessageRole::Unknown,
		]),
	);
}

#[test]
fn every_block_the_host_can_emit_is_one_the_transcript_must_render() {
	// The renderer's obligation is this set and no larger. Ten, not sixteen.
	assert_eq!(REACHABLE_BLOCKS.len(), 10);
	assert_eq!(BlockKind::iter().count(), 16);

	// Unknown and Fallback are the host's own output for content it does not
	// recognise, so they are reachable rather than defensive branches.
	let reachable = set_of(&REACHABLE_BLOCKS);
	assert!(reachable.contains(&BlockKind::Unknown));
	assert!(reachable.contains(&BlockKind::Fallback));
}
