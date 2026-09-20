//! WHY THIS SUITE EXISTS:
//! The session column gated its composer, its card stack and its run bar on
//! the queue holding a session. A window replaying a transcript whose session
//! list had not arrived drew turns with nothing to type into, and — because
//! the damage rule names `Region::Composer` beside the last turn, so the
//! float's backdrop blur repaints with the text under it — every scoped frame
//! found no box for a region that was never drawn and fell back to repainting
//! the whole window. The degradation is silent: `request_frame` answers a
//! region with no box with a full frame, which is correct and costs the
//! window its damage scoping.
//!
//! THE CLASS THIS CLOSES: a region the damage rule names that the frame did
//! not lay out. Driven through the real store, the real projection and a real
//! window:
//! 1. Across every state the session column reaches, the composer's box is
//!    absent exactly on the welcome surface — the one state with no session and
//!    no transcript — and present everywhere else. The expectation is read off
//!    the projected state, not written per fixture, so a fixture that changes
//!    shape changes what it demands.
//! 2. For every fixture that draws a transcript, a streaming delta to the last
//!    turn is diffed and requested the way the event loop does it: the diff
//!    must scope, every region it names must have a box, and the frame must be
//!    `Repaint::Within`. A region named but not drawn fails here by name rather
//!    than as a silent full repaint.
//!
//! WHAT IT DOES NOT CATCH: whether the declared rectangle covers the pixels
//! that changed, which `a-streaming-turn-repaints-inside-its-own-entry.rs`
//! proves against the raster; and a region a state these fixtures never reach
//! would name.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, fields::driven};
use veyyon_desktop::{Repaint, SessionIndex, project, request_frame};
use veyyon_desktop_model::{
	ConnectionState, ContentBlock, EntryId, HostEvent, MessageRole, PROTOCOL_VERSION,
	QueuePartition, SessionId, Store, StreamingMessageState, TranscriptEntry, reduce,
};
use veyyon_desktop_surface::{
	ShellState,
	damage::{Invalidation, Region, regions_changed},
};

/// The id every transcript fixture streams into, so a delta extends the last
/// turn rather than appending another one.
const STREAMING: &str = "streaming";

/// One state of the session column, named for what the operator is looking
/// at.
struct Fixture {
	name:  &'static str,
	store: Store,
}

fn connected() -> Store {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "unix:/run/veyyon.sock".to_owned(),
		protocol: PROTOCOL_VERSION,
	};
	store
}

fn entry(id: &str, text: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: NOW_MS + revision,
		role: MessageRole::Assistant,
		content: vec![ContentBlock::Text { text: text.to_owned() }],
		meta: None,
		raw_discriminator: "text".to_owned(),
		raw: serde_json::json!({}),
	}
}

/// A settled turn, so the column has a transcript to draw before anything
/// streams into it.
fn append_transcript(store: &mut Store) {
	reduce(store, HostEvent::TranscriptAppended {
		revision: 1,
		entries:  vec![entry("settled", "the walker caches every entry it visits", 1)],
	});
}

/// The event a host sends while a turn streams: the same entry, one word
/// longer.
fn streaming_delta(revision: u64, text: &str) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from(STREAMING),
		tool: None,
		accumulating: entry(STREAMING, text, revision),
		revision,
	}))
}

fn project_store(store: &Store) -> ShellState {
	let mut state = ShellState::default();
	let mut index = SessionIndex::default();
	project(store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	state
}

/// Every state the session column reaches: the welcome surface, a queue with
/// nothing open, an open session with nothing said yet, a transcript arriving
/// before the session list does, and a transcript under a listed session.
fn fixtures() -> Vec<Fixture> {
	let listed = || {
		let mut store = connected();
		store
			.sessions
			.insert(support::session("s1", QueuePartition::Live));
		store
	};

	let mut open = listed();
	open.persisted.shell.active_session = Some(SessionId::from("s1"));

	let mut replaying = connected();
	replaying.persisted.shell.active_session = Some(SessionId::from("s1"));
	append_transcript(&mut replaying);

	let mut attached = listed();
	attached.persisted.shell.active_session = Some(SessionId::from("s1"));
	append_transcript(&mut attached);

	vec![
		Fixture { name: "no session and no transcript", store: connected() },
		Fixture { name: "a session listed with none open", store: listed() },
		Fixture { name: "a session open with nothing said", store: open },
		Fixture { name: "a transcript before the session list", store: replaying },
		Fixture { name: "a transcript under a listed session", store: attached },
	]
}

#[test]
fn only_the_welcome_surface_draws_a_column_without_a_composer() {
	for fixture in fixtures() {
		let state = project_store(&fixture.store);
		// The welcome surface is the one state with nothing to type into.
		// Anything the operator can answer — a session, or turns replaying
		// into the column — carries the composer.
		let expected = state.has_sessions() || !state.transcript.is_empty();
		let drawn = driven(state, |session| {
			session
				.update(|view, _, _| view.laid_out().bounds(Region::Composer))
				.expect("read the composer's box back off the frame")
		});
		assert_eq!(
			drawn.is_some(),
			expected,
			"{}: the composer is drawn exactly where there is something to type into",
			fixture.name
		);
	}
}

#[test]
fn a_delta_to_the_last_turn_is_scoped_to_boxes_the_frame_drew() {
	let with_transcript: Vec<Fixture> = fixtures()
		.into_iter()
		.filter(|fixture| !project_store(&fixture.store).transcript.is_empty())
		.collect();
	assert_eq!(
		with_transcript.len(),
		2,
		"both transcript fixtures reach this sweep; a fixture that stops drawing turns is a hole"
	);

	for Fixture { name, mut store } in with_transcript {
		let state = project_store(&store);
		driven(state, move |session| {
			let mut index = SessionIndex::default();
			// The first delta opens the streaming turn, whose box no frame has
			// laid out yet: that frame is a full one by design. Drawing it is
			// what gives the next delta a box to scope to.
			reduce(&mut store, streaming_delta(2, "the walker"));
			session
				.update(|view, _, cx| {
					project(&store, &mut index, &HashMap::new(), NOW_MS, view.state_mut());
					request_frame(view, &Invalidation::Full, cx)
				})
				.expect("project the opening delta");
			session.frame().expect("draw the streaming turn once");

			let drawn = session
				.update(|view, _, _| view.state().clone())
				.expect("read the state the window drew");
			reduce(&mut store, streaming_delta(3, "the walker caches"));
			let repaint = session
				.update(|view, _, cx| {
					project(&store, &mut index, &HashMap::new(), NOW_MS, view.state_mut());
					let invalidation = regions_changed(&drawn, view.state());
					let Invalidation::Within(regions) = &invalidation else {
						panic!("{name}: a delta inside one turn asks for {invalidation:?}");
					};
					for region in regions {
						assert!(
							view.laid_out().bounds(*region).is_some(),
							"{name}: the diff names {region:?}, which the frame never laid out"
						);
					}
					request_frame(view, &invalidation, cx)
				})
				.expect("diff and request the scoped frame");
			assert!(
				matches!(repaint, Repaint::Within(_)),
				"{name}: a delta inside one turn drew {repaint:?}"
			);
		});
	}
}
