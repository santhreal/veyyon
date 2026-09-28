//! The sidebar region.
//!
//! Pinned, unsent, deferred and archived blocks, projects and their threads
//! with branches folded under their parents, thread search, the thread row
//! menu, inline rename, the peek preview, and the footer with settings, the
//! profile switcher and the connection dot. The blocks and projects
//! collapsed, the branches folded and the archived pages listed are written to
//! the store, so a window reopens them as they were left.
//!
//! The sidebar re-renders on the events it draws: the listing, the active
//! session, the connection, the capabilities, the decisions a session waits
//! on, the profile, search and preview sections, the answer to its own
//! refresh, and a stream starting or ending. A streamed delta costs one hash
//! lookup and no render. One timer runs to the next relative-time label
//! change of a drawn row, and only after a render.

mod bindings;
mod chrome;
mod headers;
mod keys;
pub mod listing;
mod menus;
pub mod model;
mod motion;
mod naming;
mod placement;
mod preview;
mod row;
mod search;

use std::{
	cell::Cell,
	collections::HashSet,
	rc::Rc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use gpui::{
	Bounds, Context, Entity, FocusHandle, Focusable, IntoElement, Pixels, Render, Subscription,
	Task, UniformListScrollHandle, Window, div, prelude::*, uniform_list,
};
use veyyon_desktop_model::{RequestId, SessionId, SnapshotSectionKind};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	overlays::ContextMenu,
	theme::ActiveTheme,
};

pub use self::bindings::init;
use self::{
	bindings::SidebarHandle,
	listing::{Item, Listing},
	menus::{ProfilePick, RowPick},
	motion::RowMotion,
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
	selected:       Option<SessionId>,
	/// Sessions a stream is running in, so a delta renders nothing.
	streaming:      HashSet<SessionId>,
	/// Whether a supervised process is alive, which the open row's glyph
	/// states.
	watching:       bool,
	naming:         Option<Naming>,
	confirm_delete: Option<SessionId>,
	row_menu:       Entity<ContextMenu>,
	menu_session:   Option<SessionId>,
	row_picks:      Vec<Option<RowPick>>,
	profile_menu:   Entity<ContextMenu>,
	profile_picks:  Vec<ProfilePick>,
	/// The profile button's bounds as last laid out, where the profile menu
	/// opens when an action asks for it.
	profile_button: Rc<Cell<Option<Bounds<Pixels>>>>,
	/// An action asked for the profile menu while the button was not laid
	/// out; the next layout opens it.
	profile_asked:  Rc<Cell<bool>>,
	peek:           Option<SessionId>,
	scroll:         UniformListScrollHandle,
	motion:         RowMotion,
	clock:          fn() -> u64,
	/// The instant the pending label timer fires at, and the timer.
	tick:           Option<(u64, Task<()>)>,
	host_search:    Option<Task<()>>,
	/// The `ListSessions` the refresh control sent, until the host answers.
	refreshing:     Option<RequestId>,
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
		let row_menu = cx.new(|cx| ContextMenu::new(Vec::new(), window, cx));
		let profile_menu = cx.new(|cx| ContextMenu::new(Vec::new(), window, cx));
		let subscriptions = vec![
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| this.on_store_event(event, cx)),
			cx.subscribe_in(&search, window, |this, _, event: &EditorEvent, window, cx| {
				this.on_search_event(*event, window, cx);
			}),
			cx.subscribe_in(&row_menu, window, Self::on_row_menu_event),
			cx.subscribe_in(&profile_menu, window, Self::on_profile_menu_event),
		];
		let handle =
			SidebarHandle { sidebar: cx.entity().downgrade(), window: window.window_handle() };
		cx.set_global(handle);
		let selected = app.read(cx).active_session().cloned();
		let mut sidebar = Self {
			app,
			focus: cx.focus_handle(),
			search,
			query: String::new(),
			folded: String::new(),
			items: Vec::new(),
			selected,
			streaming: HashSet::new(),
			watching: false,
			naming: None,
			confirm_delete: None,
			row_menu,
			menu_session: None,
			row_picks: Vec::new(),
			profile_menu,
			profile_picks: Vec::new(),
			profile_button: Rc::new(Cell::new(None)),
			profile_asked: Rc::new(Cell::new(false)),
			peek: None,
			scroll: UniformListScrollHandle::new(),
			motion: RowMotion::default(),
			clock: now_ms,
			tick: None,
			host_search: None,
			refreshing: None,
			renders: 0,
			_subscriptions: subscriptions,
		};
		sidebar.scroll.set_smooth_wheel(true);
		sidebar.watching = processes_alive(sidebar.app.read(cx));
		if let Some(active) = sidebar.selected.clone() {
			sidebar.reveal(&active, cx);
		}
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

	/// The thread row menu.
	pub const fn row_menu(&self) -> &Entity<ContextMenu> {
		&self.row_menu
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
				if let Some(active) = self.selected.clone() {
					self.reveal(&active, cx);
				}
				self.rebuild_items(cx);
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
			StoreEvent::ConnectionChanged => {
				// A link that changed does not answer what the last one sent;
				// an attach lists the threads again.
				self.refreshing = None;
				cx.notify();
			},
			StoreEvent::InteractionsChanged { .. } => cx.notify(),
			// A gate the open thread menu states changed: the host declared
			// its capabilities again, answered a request, or one was queued.
			StoreEvent::DomainChanged(SnapshotSectionKind::Capabilities) => {
				self.restate_row_menu(cx);
				cx.notify();
			},
			StoreEvent::RequestFinished { request, .. } => {
				if self.refreshing == Some(*request) {
					self.refreshing = None;
					cx.notify();
				}
				self.restate_row_menu(cx);
			},
			StoreEvent::OutboxReady => self.restate_row_menu(cx),
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
			StoreEvent::DomainChanged(SnapshotSectionKind::Processes) => {
				let watching = processes_alive(self.app.read(cx));
				if watching != self.watching {
					self.watching = watching;
					cx.notify();
				}
			},
			_ => {},
		}
	}

	fn rebuild_items(&mut self, cx: &Context<Self>) {
		let app = self.app.read(cx);
		self.items = Listing { app, query: &self.folded }.items();
		self
			.motion
			.relist(&self.items, app.projects(), &self.folded, cx);
	}

	/// Hides the threads of the project at `path`, or shows them when hidden.
	fn toggle_project(&mut self, path: &str, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| app.toggle_project(path, cx));
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
		self.motion.step(window, cx);
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
			.on_action(cx.listener(Self::toggle_pin_selected))
			.on_action(cx.listener(Self::toggle_defer_selected))
			.on_action(cx.listener(Self::toggle_archive_selected))
			.on_action(cx.listener(Self::fold_selected))
			.on_action(cx.listener(Self::unfold_selected))
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

/// Whether a supervised process is alive, which the open row's glyph states.
fn processes_alive(app: &AppState) -> bool {
	app.store()
		.domains
		.processes
		.iter()
		.any(veyyon_desktop_model::ProcessView::is_alive)
}
