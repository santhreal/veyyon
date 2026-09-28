//! The transcript: the open session's entries as one virtualized list.
//!
//! One list item is one entry of the active branch, and while a reply streams
//! the list holds one more: the streaming tail ([`tail::StreamingTail`]), its
//! own entity, drawn as the last item. The list follows the store's splices
//! (`ListState::splice`), so an entry arriving measures itself and the turn it
//! landed in and nothing else; a delta notifies the tail, remeasures its one
//! slot and lays the list out, which draws only the items on screen. A reply
//! taller than the thread scrolls with the list, which
//! follows the tail while it is at the bottom. When the stream ends the
//! committed entry takes the tail's slot in place, at the same index and
//! scroll offset.

mod blocks;
mod entry;
mod hover;
pub mod plan;
mod position;
mod reveal;
mod row;
mod slot;
pub mod tail;
pub mod tool;
pub mod turn;
pub mod values;

use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use gpui::{
	Context, Entity, FollowMode, ListAlignment, ListOffset, ListState, Render, Subscription,
	WeakEntity, Window, div, list, prelude::*,
};
use veyyon_desktop_model::{
	EntryId, HostAction, SessionId, SnapshotSectionKind, SurfaceId, TranscriptAnchor,
};
use veyyon_desktop_ui::{
	controls::hover_transition,
	markdown::MarkdownDoc,
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use self::{slot::Slot, tail::StreamingTail, turn::TurnIndex};
use crate::{AppState, StoreEvent, driver};

/// The transcript region.
pub struct Transcript {
	app:           Entity<AppState>,
	session:       Option<SessionId>,
	list:          ListState,
	tail:          Entity<StreamingTail>,
	/// The entry items the list holds; the tail slot, when present, is item
	/// `entries`.
	entries:       usize,
	slot:          Slot,
	turns:         TurnIndex,
	/// Parsed prose by entry and block, with the entry revision it was parsed
	/// at.
	docs:          HashMap<(EntryId, usize), (u64, MarkdownDoc)>,
	/// Decoded images by entry and block.
	images:        HashMap<(EntryId, usize), Arc<gpui::Image>>,
	tools:         HashMap<String, bool>,
	thoughts:      HashSet<(EntryId, usize)>,
	turns_open:    HashSet<usize>,
	working:       bool,
	at_end:        bool,
	/// The first entry the last scroll-back request asked for history before.
	requested:     Option<EntryId>,
	/// A remembered read position whose entry is not on the branch yet.
	pending:       Option<TranscriptAnchor>,
	/// How many prose blocks have been parsed, and how many entry items drawn.
	parses:        usize,
	item_renders:  usize,
	/// The entries the list has held, and the reveal of each that landed.
	reveal:        reveal::Reveal,
	_subscription: Subscription,
}

impl Transcript {
	/// Creates the region over `app`, showing its active session.
	pub fn new(app: Entity<AppState>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
		let subscription =
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| this.on_store(event, cx));
		let tail = cx.new(|_| StreamingTail::new(app.clone()));
		let list = ListState::new(0, ListAlignment::Bottom, size::COLUMN_MAX);
		list.set_follow_mode(FollowMode::Tail);
		list.set_smooth_follow(true);
		let weak = cx.entity().downgrade();
		list.set_scroll_handler(move |event, _, cx| {
			let top = event.visible_range.start == 0;
			let at_end = !event.is_scrolled || event.is_following_tail;
			weak
				.update(cx, |this, cx| this.on_scroll(top, at_end, cx))
				.ok();
		});
		let mut this = Self {
			app,
			session: None,
			list,
			tail,
			entries: 0,
			slot: Slot::Absent,
			turns: TurnIndex::default(),
			docs: HashMap::new(),
			images: HashMap::new(),
			tools: HashMap::new(),
			thoughts: HashSet::new(),
			turns_open: HashSet::new(),
			working: false,
			at_end: true,
			requested: None,
			pending: None,
			parses: 0,
			item_renders: 0,
			reveal: reveal::Reveal::default(),
			_subscription: subscription,
		};
		this.show_active(cx);
		this
	}

	/// The session the list shows.
	#[must_use]
	pub const fn session(&self) -> Option<&SessionId> {
		self.session.as_ref()
	}

	/// The number of items the list holds: the entries, and the tail while
	/// it has a slot.
	#[must_use]
	pub fn item_count(&self) -> usize {
		self.list.item_count()
	}

	/// The streaming tail entity.
	#[must_use]
	pub const fn tail(&self) -> &Entity<StreamingTail> {
		&self.tail
	}

	/// The item at the top of the view and how far the view starts past it.
	#[must_use]
	pub fn scroll_top(&self) -> ListOffset {
		self.list.logical_scroll_top()
	}

	/// How many prose blocks the region has parsed.
	#[must_use]
	pub const fn parses(&self) -> usize {
		self.parses
	}

	/// How many times an entry item has been drawn.
	#[must_use]
	pub const fn item_renders(&self) -> usize {
		self.item_renders
	}

	fn on_store(&mut self, event: &StoreEvent, cx: &mut Context<Self>) {
		match event {
			StoreEvent::ActiveSessionChanged => self.show_active(cx),
			StoreEvent::TranscriptReset { session } if self.session.as_ref() == Some(session) => {
				self.reset(cx);
			},
			StoreEvent::TranscriptSpliced { session, range, count }
				if self.session.as_ref() == Some(session) =>
			{
				self.splice(range, *count, cx);
			},
			StoreEvent::StreamingChanged { session } if self.session.as_ref() == Some(session) => {
				self.sync_tail(cx);
				self.refresh_working(cx);
			},
			StoreEvent::InteractionsChanged { session } if self.session.as_ref() == Some(session) => {
				self.refresh_working(cx);
			},
			// An extension's working message replaces the tail's own text.
			StoreEvent::DomainChanged(SnapshotSectionKind::ExtensionUi) => {
				self.sync_tail(cx);
				self.refresh_working(cx);
			},
			StoreEvent::DomainChanged(_) => self.refresh_working(cx),
			_ => {},
		}
	}

	/// Remeasures the last turn when the agent starts or stops working, which
	/// is when that turn folds or unfolds. A delta that changes nothing else
	/// costs one comparison.
	fn refresh_working(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let working = self.app.read(cx).is_working(&session);
		if working == self.working {
			return;
		}
		self.working = working;
		let count = self.entries;
		let start = count
			.checked_sub(1)
			.and_then(|last| self.turns.turn_at(last))
			.map_or(count, |turn| turn.range.start);
		self.list.remeasure_items(start..count);
		cx.notify();
	}

	fn show_active(&mut self, cx: &mut Context<Self>) {
		let active = self.app.read(cx).active_session().cloned();
		if active == self.session && self.session.is_some() {
			return;
		}
		self.session = active;
		self.tools.clear();
		self.thoughts.clear();
		self.turns_open.clear();
		self.requested = None;
		self.pending = None;
		self.reset(cx);
		self.list.set_follow_mode(FollowMode::Tail);
		self.at_end = true;
		self.restore_position(cx);
	}

	fn reset(&mut self, cx: &mut Context<Self>) {
		self.docs.clear();
		self.images.clear();
		let app = self.app.read(cx);
		let count = self
			.session
			.as_ref()
			.map_or(0, |session| app.entry_count(session));
		self.working = self
			.session
			.as_ref()
			.is_some_and(|session| app.is_working(session));
		if let Some(session) = &self.session {
			self.turns.rebuild(app, session);
			let ids = (0..count).filter_map(|ix| app.entry_at(session, ix));
			self.reveal.reset(ids.map(|entry| entry.id.0.as_str()));
		} else {
			self.turns = TurnIndex::default();
			self.reveal.reset(std::iter::empty());
		}
		self.entries = count;
		self.slot = Slot::Absent;
		self.list.reset(count);
		self.tail.update(cx, |tail, cx| tail.release(cx));
		self.sync_tail(cx);
		cx.notify();
		self.place_position(cx);
	}

	fn on_scroll(&mut self, top: bool, at_end: bool, cx: &mut Context<Self>) {
		if at_end != self.at_end {
			self.at_end = at_end;
			cx.notify();
		}
		// The list is borrowed while its scroll handler runs, so the position
		// is read from it once the handler has returned.
		let weak = Self::weak(cx);
		cx.defer(move |cx| {
			weak
				.update(cx, |this, cx| this.record_position(at_end, cx))
				.ok();
		});
		if !top {
			return;
		}
		let Some(session) = self.session.clone() else {
			return;
		};
		let first = self
			.app
			.read(cx)
			.entry_at(&session, 0)
			.map(|entry| entry.id.clone());
		if first.is_none() || first == self.requested {
			return;
		}
		self.requested.clone_from(&first);
		self.app.update(cx, |app, cx| {
			app.dispatch(
				HostAction::LoadTranscript { session: session.clone(), before: first },
				SurfaceId::GlobalTitlebarLine,
				cx,
			);
		});
	}

	fn jump_to_end(&mut self, cx: &mut Context<Self>) {
		self.list.set_follow_mode(FollowMode::Tail);
		self.at_end = true;
		cx.notify();
		self.record_position(true, cx);
	}

	/// Opens or closes tool row `call_id` at item `ix` and tells the host, so
	/// the next snapshot keeps the operator's choice.
	fn toggle_tool(&mut self, ix: usize, call_id: String, open: bool, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		self.tools.insert(call_id.clone(), open);
		self.list.remeasure_items(ix..ix + 1);
		self.app.update(cx, |app, cx| {
			app.dispatch(
				HostAction::SetToolViewExpanded { session, call_id, expanded: open },
				SurfaceId::GlobalTitlebarLine,
				cx,
			);
		});
		cx.notify();
	}

	fn toggle_thought(&mut self, ix: usize, key: (EntryId, usize), cx: &mut Context<Self>) {
		if !self.thoughts.remove(&key) {
			self.thoughts.insert(key);
		}
		self.list.remeasure_items(ix..ix + 1);
		cx.notify();
	}

	fn toggle_turn(&mut self, anchor: usize, cx: &mut Context<Self>) {
		if !self.turns_open.remove(&anchor) {
			self.turns_open.insert(anchor);
		}
		if let Some(turn) = self.turns.turn_at(anchor) {
			self.list.remeasure_items(turn.range.clone());
		}
		cx.notify();
	}

	fn weak(cx: &Context<Self>) -> WeakEntity<Self> {
		cx.entity().downgrade()
	}
}

impl Render for Transcript {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.reveal.step(window, cx);
		let palette = cx.theme().palette;
		let weak = Self::weak(cx);
		let (entries, tail) = (self.entries, self.tail.clone());
		let items = list(self.list.clone(), move |ix, window, cx| {
			if ix >= entries {
				return driver::target("transcript.tail", tail.clone());
			}
			weak
				.update(cx, |this, cx| this.render_entry(ix, window, cx))
				.unwrap_or_else(|_| div().into_any_element())
		})
		.size_full();
		let jump = (!self.at_end && self.list.item_count() > 0).then(|| {
			let weak = Self::weak(cx);
			div()
				.absolute()
				.bottom(space::S4)
				.w_full()
				.flex()
				.justify_center()
				.child(
					div()
						.id("transcript-jump")
						.px(space::S3)
						.py(space::S1)
						.rounded(radius::FULL)
						.bg(palette.bg.elevated)
						.border_1()
						.border_color(palette.border.default)
						.type_style(text::SMALL)
						.text_color(palette.text.secondary)
						.cursor_pointer()
						.transition(hover_transition())
						.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
						.child("↓ Latest")
						.on_click(move |_, _, cx| {
							weak.update(cx, |this, cx| this.jump_to_end(cx)).ok();
						}),
				)
		});
		driver::target(
			"transcript",
			div()
				.relative()
				.size_full()
				.bg(palette.bg.app)
				.child(items)
				.children(jump),
		)
	}
}
