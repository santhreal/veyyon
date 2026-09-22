//! WHY: a domain section the host sends is the whole of that domain at that
//! moment. A reducer that merged it with what it held would show a file the
//! host no longer lists, a terminal that exited, a provider that was removed.
//!
//! CLASS CLOSED: a `SnapshotSection` variant whose reduction merges rather
//! than replaces. The variants are swept from `SnapshotSectionKind` at run
//! time, and the match in `sections::pair` is exhaustive, so a section added
//! to the protocol fails to compile until it is given a pair there or recorded
//! as one that does not land in `Domains`. The replacement invariant is
//! generic: reducing A then B leaves `Domains` equal to reducing B alone.
//!
//! NOT CAUGHT: the sections that do not land in `Domains`. Sessions, the
//! active session, the transcript, capabilities and interactions have their
//! own suites; the two chunk kinds accumulate by design and are in
//! `a-chunk-accumulates-resets-and-records-a-gap.rs`; the agent freeze is a
//! field of its own, and replaces in
//! `crates/veyyon-desktop/tests/a-freeze-the-host-engaged-reaches-every-window.
//! rs`.

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind, Store, reduce};

mod sections;

use sections::pair;

#[test]
fn every_domain_section_replaces_its_domain_and_the_opt_outs_are_named() {
	let mut opted_out = Vec::new();
	for kind in SnapshotSectionKind::iter() {
		let Some([first, second]) = pair(kind) else {
			opted_out.push(kind);
			continue;
		};
		assert_eq!(SnapshotSectionKind::from(&first), kind);
		assert_eq!(SnapshotSectionKind::from(&second), kind);
		assert_ne!(first, second, "{kind:?}: a pair of equal sections proves nothing");

		let mut store = Store::new();
		let untouched = store.domains.clone();
		reduce(&mut store, HostEvent::Snapshot(first));
		let after_first = store.domains.clone();
		assert_ne!(after_first, untouched, "{kind:?}: the first section landed nowhere");
		reduce(&mut store, HostEvent::Snapshot(second.clone()));
		assert_ne!(store.domains, after_first, "{kind:?}: the second section landed nowhere");

		let mut alone = Store::new();
		reduce(&mut alone, HostEvent::Snapshot(second));
		assert_eq!(
			store.domains, alone.domains,
			"{kind:?}: reducing two sections in turn differs from reducing the last alone, so the \
			 reducer merged what the host replaced"
		);
	}
	assert_eq!(opted_out, [
		SnapshotSectionKind::Sessions,
		SnapshotSectionKind::ActiveSession,
		SnapshotSectionKind::Transcript,
		SnapshotSectionKind::Capabilities,
		SnapshotSectionKind::Interactions,
		SnapshotSectionKind::TerminalOutput,
		SnapshotSectionKind::ProcessLogs,
		SnapshotSectionKind::QueuedPrompts,
		SnapshotSectionKind::AgentPause,
		SnapshotSectionKind::Goal,
	]);
}
