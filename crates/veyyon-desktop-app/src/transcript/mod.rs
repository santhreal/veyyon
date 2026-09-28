//! The transcript: the open session's entries as one virtualized list.
//!
//! One list item is one entry of the active branch. The list follows the
//! store's splices (`ListState::splice`), so an entry arriving measures itself
//! and the turn it landed in and nothing else. The streaming reply is not an
//! item: it is `thread::tail::StreamingTail`, a sibling entity, so a streamed
//! delta never re-renders this one.

mod entry;
pub mod plan;
pub mod tool;
pub mod turn;
pub mod values;

use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use gpui::{
	Context, Entity, ListAlignment, ListState, Render, Subscription, WeakEntity, Window, div, list,
	prelude::*,
};
use veyyon_desktop_model::{EntryId, HostAction, SessionId, SurfaceId};
use veyyon_desktop_ui::{
	markdown::MarkdownDoc,
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use self::turn::TurnIndex;
use crate::{AppState, StoreEvent};

/// The transcript region.
pub struct Transcript {
	app:           Entity<AppState>,
	session:       Option<SessionId>,
	list:          ListState,
	turns:         TurnIndex,
	/// Parsed prose by entry and block, with the entry revision it was parsed at.
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
	_subscription: Subscription,
}

impl Transcript {
	/// Creates the region over `app`, showing its active session.
	pub fn new(app: Entity<AppState>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |this, _, event: &StoreEvent, cx| this.on_store(event, cx));
		let list = ListState::new(0, ListAlignment::Bottom, size::COLUMN_MAX);
		let weak = cx.entity().downgrade();
		list.set_scroll_handler(move |event, _, cx| {
			let (top, following) = (event.visible_range.start == 0, event.is_following_tail);
			weak.update(cx, |this, cx| this.on_scroll(top, following, cx)).ok();
		});
		let mut this = Self {
			app,
			session: None,
			list,
			turns: TurnIndex::default(),
			docs: HashMap::new(),
			images: HashMap::new(),
			tools: HashMap::new(),
			thoughts: HashSet::new(),
			turns_open: HashSet::new(),
			working: false,
			at_end: true,
			requested: None,
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

	/// The number of items the list holds.
	#[must_use]
	pub fn item_count(&self) -> usize {
		self.list.item_count()
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
				self.list.splice(range.clone(), *count);
				let app = self.app.read(cx);
				let touched = self.turns.splice(app, session, range);
				let spliced = range.start..range.start + count;
				if touched.start < spliced.start {
					self.list.remeasure_items(touched.start..spliced.start);
				}
				if spliced.end < touched.end {
					self.list.remeasure_items(spliced.end..touched.end);
				}
				cx.notify();
			},
			StoreEvent::StreamingChanged { session } | StoreEvent::InteractionsChanged { session }
				if self.session.as_ref() == Some(session) =>
			{
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
		let Some(session) = self.session.clone() else { return };
		let working = self.app.read(cx).is_working(&session);
		if working == self.working {
			return;
		}
		self.working = working;
		let count = self.list.item_count();
		let start = count.checked_sub(1).and_then(|last| self.turns.turn_at(last)).map_or(count, |turn| turn.range.start);
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
		self.reset(cx);
	}

	fn reset(&mut self, cx: &mut Context<Self>) {
		self.docs.clear();
		self.images.clear();
		let app = self.app.read(cx);
		let count = self.session.as_ref().map_or(0, |session| app.entry_count(session));
		self.working = self.session.as_ref().is_some_and(|session| app.is_working(session));
		match &self.session {
			Some(session) => self.turns.rebuild(app, session),
			None => self.turns = TurnIndex::default(),
		}
		self.list.reset(count);
		cx.notify();
	}

	fn on_scroll(&mut self, top: bool, following: bool, cx: &mut Context<Self>) {
		if following != self.at_end {
			self.at_end = following;
			cx.notify();
		}
		if !top {
			return;
		}
		let Some(session) = self.session.clone() else { return };
		let first = self.app.read(cx).entry_at(&session, 0).map(|entry| entry.id.clone());
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

	/// Opens or closes tool row `call_id` at item `ix` and tells the host, so
	/// the next snapshot keeps the operator's choice.
	fn toggle_tool(&mut self, ix: usize, call_id: String, open: bool, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else { return };
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
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		let weak = Self::weak(cx);
		let items = list(self.list.clone(), move |ix, window, cx| {
			weak.update(cx, |this, cx| this.render_entry(ix, window, cx))
				.unwrap_or_else(|_| div().into_any_element())
		})
		.size_full();
		let jump = (!self.at_end && self.list.item_count() > 0).then(|| {
			let list = self.list.clone();
			div().absolute().bottom(space::S4).w_full().flex().justify_center().child(
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
					.child("↓ Latest")
					.on_click(move |_, _, _| list.scroll_to_end()),
			)
		});
		crate::driver::target(
			"transcript",
			div().relative().size_full().bg(palette.bg.app).child(items).children(jump),
		)
	}
}
