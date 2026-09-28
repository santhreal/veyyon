//! The transcript draws what the host recorded as the operator reads it: a
//! prompt as the words it held and the files it named, a tool result that
//! failed as a failure, a plan's title as words rather than the markdown it
//! was written in, and the view where the operator left it.
//!
//! WHY: the window draws every entry through one plan per entry and every
//! decision through one card, so a case the plan does not state falls through
//! to a default that reads as something else: a prompt of files alone drew an
//! empty bubble, a named picture drew its name twice and no picture, a failed
//! result with no call row read as a success, and a plan's title drew its
//! asterisks and then drew again in the body. A read position was not kept at
//! all, so every switch and relaunch dropped the operator at the live edge.
//! The suite drives the real `ThreadView` over an `AppState` fed host events
//! and reads the plan each item is drawn from, the text runs the frame
//! painted, the list's scroll position and the store the window writes.
//!
//! Gap: glyph colors, the markdown renderer's own output and a decoded
//! image's pixels are not read; a picture is proven drawn by the fallback
//! words it did not draw.

mod decision;
mod mentions;
mod position;
mod tools;

use std::collections::{HashMap, HashSet};

use gpui::{
	AppContext as _, Bounds, Entity, Modifiers, Pixels, ScrollDelta, ScrollWheelEvent,
	TestAppContext, TouchPhase, VisualTestContext, point, px, size,
};
use veyyon_desktop_app::{
	AppState, driver,
	thread::ThreadView,
	transcript::{
		Transcript,
		plan::{Opened, Plan, plan_entry},
		turn::TurnIndex,
	},
};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionHeaderView, SessionId, SnapshotSection,
	Store, TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window every test draws in.
pub const WINDOW: (f32, f32) = (1000.0, 1000.0);

pub fn sid() -> SessionId {
	SessionId::from("s")
}

/// An entry of `role` holding `content`, the child of `parent`.
pub fn entry(
	id: &str,
	parent: Option<&str>,
	role: MessageRole,
	content: Vec<ContentBlock>,
) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision: 1,
		timestamp_ms: 1,
		role,
		content,
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

pub fn text(words: &str) -> ContentBlock {
	ContentBlock::Text { text: words.to_owned() }
}

/// `entries` chained in order, each the child of the one before.
pub fn chain(entries: Vec<(&str, MessageRole, Vec<ContentBlock>)>) -> Vec<TranscriptEntry> {
	let mut parent: Option<&str> = None;
	entries
		.into_iter()
		.map(|(id, role, content)| {
			let linked = entry(id, parent, role, content);
			parent = Some(id);
			linked
		})
		.collect()
}

/// The host sending session `s`'s transcript whole, at `revision`.
pub const fn snapshot(revision: u64, entries: Vec<TranscriptEntry>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Transcript(Versioned { revision, value: entries }))
}

/// The host making session `s` active and sending `entries`.
pub fn opened(entries: Vec<TranscriptEntry>) -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             sid(),
		schema_version: 1,
		title:          None,
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            "/w/s".to_owned(),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		snapshot(1, entries),
	]
}

/// A `width` × `height` 24-bit bitmap, the one image format simple enough
/// to write out by hand.
pub fn bitmap(width: u32, height: u32) -> Vec<u8> {
	let row = width * 3;
	let data = row * height;
	let mut bytes = Vec::with_capacity(54 + data as usize);
	bytes.extend_from_slice(b"BM");
	for word in [54 + data, 0, 54, 40, width, height] {
		bytes.extend_from_slice(&word.to_le_bytes());
	}
	bytes.extend_from_slice(&1u16.to_le_bytes());
	bytes.extend_from_slice(&24u16.to_le_bytes());
	for word in [0, data, 2835, 2835, 0, 0] {
		bytes.extend_from_slice(&word.to_le_bytes());
	}
	bytes.resize(54 + data as usize, 0x80);
	bytes
}

/// The thread of session `s`, drawn in a window.
pub struct Thread<'a> {
	pub state:      Entity<AppState>,
	pub transcript: Entity<Transcript>,
	pub cx:         &'a mut VisualTestContext,
}

/// Opens the thread over a fresh store fed `events`.
pub fn thread(app: &mut TestAppContext, events: Vec<HostEvent>) -> Thread<'_> {
	thread_over(app, Store::new(), events)
}

/// Opens the thread over `store`, as a window started from what the last
/// one wrote, fed `events`, and drops the requests the events queued.
pub fn thread_over(app: &mut TestAppContext, store: Store, events: Vec<HostEvent>) -> Thread<'_> {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		cx.set_reduce_motion(true);
	});
	let state = app.new(|_| AppState::new(store));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let (view, cx) = app.add_window_view(|window, cx| ThreadView::new(view_state, window, cx));
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let transcript = view.read_with(cx, |view, _| view.transcript().clone());
	Thread { state, transcript, cx }
}

impl Thread<'_> {
	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	/// The text runs the last frame painted, with where each was painted.
	pub fn runs(&mut self) -> Vec<(String, Bounds<Pixels>)> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| (run.text.to_string(), run.bounds))
				.collect()
		})
	}

	pub fn drew(&mut self, text: &str) -> bool {
		self.drew_times(text) > 0
	}

	/// How many runs the last frame painted reading `text`.
	pub fn drew_times(&mut self, text: &str) -> usize {
		self.runs().iter().filter(|(run, _)| run == text).count()
	}

	/// A touchpad scroll of `dy` pixels over the transcript; positive
	/// scrolls back.
	pub fn wheel(&mut self, dy: f32) {
		let at = self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), "transcript"))
			.expect("the transcript was laid out")
			.center();
		self.cx.simulate_event(ScrollWheelEvent {
			position:    at,
			delta:       ScrollDelta::Pixels(point(px(0.0), px(dy))),
			modifiers:   Modifiers::default(),
			touch_phase: TouchPhase::Moved,
		});
		self.cx.run_until_parked();
	}

	/// The ids on the active branch, in display order.
	pub fn ids(&mut self) -> Vec<String> {
		self.state.read_with(&*self.cx, |state, _| {
			(0..state.entry_count(&sid()))
				.filter_map(|ix| state.entry_at(&sid(), ix))
				.map(|entry| entry.id.0.clone())
				.collect()
		})
	}

	/// The plan item `ix` is drawn from, with every finished turn unfolded.
	pub fn plan(&mut self, ix: usize) -> Plan {
		self.state.read_with(&*self.cx, |state, _| {
			let mut index = TurnIndex::default();
			index.rebuild(state, &sid());
			let turns: HashSet<usize> = (0..state.entry_count(&sid()))
				.filter_map(|at| index.turn_at(at).map(|turn| turn.range.start))
				.collect();
			let opened = Opened {
				tools:    &HashMap::new(),
				thoughts: &HashSet::new(),
				turns:    &turns,
				working:  state.is_working(&sid()),
			};
			plan_entry(state, &sid(), ix, &index, &opened)
				.unwrap_or_else(|| panic!("item {ix} is on the branch"))
		})
	}
}
