//! The sidebar: projects and their threads, thread search, the thread row
//! menu, inline rename, the peek preview, and the footer with settings, the
//! profile switcher and the connection dot.
//!
//! The sidebar re-renders on the events it draws: the listing, the active
//! session, the connection, the decisions a session waits on, the profile,
//! search and preview sections, and a stream starting or ending. A streamed
//! delta costs one hash lookup and no render. One timer runs to the next
//! relative-time label change of a drawn row, and only after a render.

mod chrome;
mod keys;
mod menus;
pub mod model;
mod naming;
mod preview;
mod row;
mod search;

use std::{
	collections::HashSet,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use gpui::{
	Context, Entity, FocusHandle, Focusable, IntoElement, Render, Subscription, Task,
	UniformListScrollHandle, Window, div, prelude::*, uniform_list,
};
use veyyon_desktop_model::{SessionId, SnapshotSectionKind};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	overlays::ContextMenu,
	theme::ActiveTheme,
};

use self::{
	menus::ProfilePick,
	model::{Item, visible_items},
	naming::Naming,
};
use crate::{AppState, StoreEvent, driver};

/// The sidebar region.
pub struct Sidebar {
	app:            Entity<AppState>,
	focus:          FocusHandle,
	search:         Entity<Editor>,
	/// The search text as typed, trimmed.
	query:          String,
	/// [`query`](Self::query) lowercased, which the local filter matches.
	folded:         String,
	items:          Vec<Item>,
	/// Paths of the projects whose threads are hidden.
	collapsed:      HashSet<String>,
	selected:       Option<SessionId>,
	/// Sessions a stream is running in, so a delta renders nothing.
	streaming:      HashSet<SessionId>,
	naming:         Option<Naming>,
	confirm_delete: Option<SessionId>,
	row_menu:       Entity<ContextMenu>,
	menu_session:   Option<SessionId>,
	profile_menu:   Entity<ContextMenu>,
	profile_picks:  Vec<ProfilePick>,
	peek:           Option<SessionId>,
	scroll:         UniformListScrollHandle,
	clock:          fn() -> u64,
	/// The instant the pending label timer fires at, and the timer.
	tick:           Option<(u64, Task<()>)>,
	host_search:    Option<Task<()>>,
	renders:        usize,
	_subscriptions: Vec<Subscription>,
}

impl Sidebar {
	/// The sidebar over `app`.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let search = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_placeholder("Search threads", cx);
			editor
		});
		crate::workspace::register_focus(
			crate::workspace::FocusSlot::SidebarSearch,
			&search.focus_handle(cx),
			cx,
		);
		let row_menu = cx.new(|cx| ContextMenu::new(menus::row_items(), window, cx));
		let profile_menu = cx.new(|cx| ContextMenu::new(Vec::new(), window, cx));
		let subscriptions = vec![
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| this.on_store_event(event, cx)),
			cx.subscribe_in(&search, window, |this, _, event: &EditorEvent, window, cx| {
				this.on_search_event(*event, window, cx);
			}),
			cx.subscribe_in(&row_menu, window, Self::on_row_menu_event),
			cx.subscribe_in(&profile_menu, window, Self::on_profile_menu_event),
		];
		let selected = app.read(cx).active_session().cloned();
		let mut sidebar = Self {
			app,
			focus: cx.focus_handle(),
			search,
			query: String::new(),
			folded: String::new(),
			items: Vec::new(),
			collapsed: HashSet::new(),
			selected,
			streaming: HashSet::new(),
			naming: None,
			confirm_delete: None,
			row_menu,
			menu_session: None,
			profile_menu,
			profile_picks: Vec::new(),
			peek: None,
			scroll: UniformListScrollHandle::new(),
			clock: now_ms,
			tick: None,
			host_search: None,
			renders: 0,
			_subscriptions: subscriptions,
		};
		sidebar.rebuild_items(cx);
		sidebar.rebuild_profile_menu(cx);
		sidebar
	}

	/// The lines the sidebar lists, in order.
	pub fn items(&self) -> &[Item] {
		&self.items
	}

	/// How many times the sidebar has rendered.
	pub const fn render_count(&self) -> usize {
		self.renders
	}

	/// Reads the time from `clock`, in milliseconds since the Unix epoch.
	pub fn set_clock(&mut self, clock: fn() -> u64, cx: &mut Context<Self>) {
		self.clock = clock;
		self.tick = None;
		cx.notify();
	}

	fn on_store_event(&mut self, event: &StoreEvent, cx: &mut Context<Self>) {
		match event {
			StoreEvent::SessionsChanged => {
				self.rebuild_items(cx);
				cx.notify();
			},
			StoreEvent::ActiveSessionChanged => {
				self.selected = self.app.read(cx).active_session().cloned();
				cx.notify();
			},
			StoreEvent::StreamingChanged { session } => {
				let running = self.app.read(cx).store().streaming.contains_key(session);
				let changed = if running {
					self.streaming.insert(session.clone())
				} else {
					self.streaming.remove(session)
				};
				if changed {
					cx.notify();
				}
			},
			StoreEvent::ConnectionChanged | StoreEvent::InteractionsChanged { .. } => cx.notify(),
			StoreEvent::DomainChanged(SnapshotSectionKind::Profiles) => {
				self.rebuild_profile_menu(cx);
				cx.notify();
			},
			StoreEvent::DomainChanged(SnapshotSectionKind::SessionSearch)
				if !self.query.is_empty() =>
			{
				cx.notify();
			},
			StoreEvent::DomainChanged(SnapshotSectionKind::SessionTranscript)
				if self.peek.is_some() =>
			{
				cx.notify();
			},
			_ => {},
		}
	}

	fn rebuild_items(&mut self, cx: &Context<Self>) {
		self.items = visible_items(self.app.read(cx).projects(), &self.collapsed, &self.folded);
	}

	/// Shows or hides the threads of the project at `path`.
	fn toggle_project(&mut self, path: &str, cx: &mut Context<Self>) {
		if !self.collapsed.remove(path) {
			self.collapsed.insert(path.to_owned());
		}
		self.rebuild_items(cx);
		cx.notify();
	}

	/// Runs one timer to `at_ms`, unless one already runs to an earlier
	/// instant. `u64::MAX` stops it.
	fn arm_tick(&mut self, at_ms: u64, cx: &Context<Self>) {
		if at_ms == u64::MAX {
			self.tick = None;
			return;
		}
		if self.tick.as_ref().is_some_and(|(due, _)| *due <= at_ms) {
			return;
		}
		let delay = Duration::from_millis(at_ms.saturating_sub((self.clock)()));
		let task = cx.spawn(async move |this, cx| {
			cx.background_executor().timer(delay).await;
			let _ = this.update(cx, |this, cx| {
				this.tick = None;
				cx.notify();
			});
		});
		self.tick = Some((at_ms, task));
	}
}

impl Focusable for Sidebar {
	fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for Sidebar {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let list = uniform_list(
			"sidebar-threads",
			self.items.len(),
			cx.processor(|this, range, window, cx| this.render_items(range, window, cx)),
		)
		.track_scroll(&self.scroll)
		.flex_1()
		.px(veyyon_desktop_ui::theme::space::S2);
		let root = div()
			.id("sidebar")
			.key_context(keys::KEY_CONTEXT)
			.track_focus(&self.focus)
			.on_action(cx.listener(Self::select_prev))
			.on_action(cx.listener(Self::select_next))
			.on_action(cx.listener(Self::open_selected))
			.on_action(cx.listener(Self::rename_selected))
			.on_action(cx.listener(Self::delete_selected))
			.on_action(cx.listener(Self::cancel))
			.flex()
			.flex_col()
			.size_full()
			.overflow_hidden()
			.bg(palette.bg.sidebar)
			.border_r_1()
			.border_color(palette.border.subtle)
			.child(self.render_header(cx))
			.child(list)
			.children(self.render_search_hits(cx))
			.children(self.render_preview(cx))
			.children(self.render_profile_naming(cx))
			.child(self.render_footer(window, cx))
			.child(self.row_menu.clone())
			.child(self.profile_menu.clone());
		driver::target("sidebar", root)
	}
}

/// The wall clock in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
