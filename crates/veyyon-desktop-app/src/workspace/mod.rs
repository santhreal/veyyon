//! The window's root view: it lays out the regions it is given, resizes and
//! slides them, and answers the `workspace` actions.
//!
//! The workspace never names a region type. The caller constructs each
//! region and hands it over as an [`AnyView`] in [`Regions`]; the workspace
//! draws each through `cached`, so a region re-renders only when it notifies.
//! A region reads the layout from the [`WorkspaceLayout`] global and changes
//! it by dispatching a `workspace` action.

mod actions;
mod banner;
mod empty;
mod geometry;
mod layout;
mod notices;
mod render;
mod titlebar;

use gpui::{
	AnyView, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
	Subscription, Window,
};
use veyyon_desktop_model::PanelsStore;
use veyyon_desktop_ui::overlays::Toasts;

use self::{banner::ConnectionBanner, empty::EmptyState, geometry::Slides, notices::Notices};
pub use self::{
	geometry::{Openness, Sizes},
	layout::{DEFAULT_PANEL_TAB, FocusSlot, WorkspaceLayout, focus_slot, register_focus},
	titlebar::{drag_region, window_controls},
};
use crate::{AppState, StoreEvent};

/// The regions the workspace lays out, each constructed by the caller.
pub struct Regions {
	/// The project and thread list at the left.
	pub sidebar:  AnyView,
	/// The active thread: header, transcript, dock and composer.
	pub thread:   AnyView,
	/// The right panel.
	pub panel:    AnyView,
	/// The terminal drawer under the thread.
	pub drawer:   AnyView,
	/// The command palette, drawn over everything.
	pub palette:  AnyView,
	/// The settings, drawn in place of the thread.
	pub settings: AnyView,
}

/// What the workspace reports to its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceEvent {
	/// A region opened, closed, changed tab or was resized. The store holds
	/// the new layout over the fields of the store the workspace opened with.
	LayoutChanged(PanelsStore),
}

/// The window's root view.
pub struct Workspace {
	app:            Entity<AppState>,
	regions:        Regions,
	sizes:          Sizes,
	slides:         Slides,
	/// The layout the regions were last laid out for.
	shown:          WorkspaceLayout,
	/// The persisted fields the workspace does not own, written back as is.
	store:          PanelsStore,
	focus:          FocusHandle,
	/// The announcement queue drawn as toasts.
	notices:        Notices,
	banner:         Entity<ConnectionBanner>,
	empty:          Entity<EmptyState>,
	_subscriptions: [Subscription; 3],
}

impl EventEmitter<WorkspaceEvent> for Workspace {}

impl Focusable for Workspace {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

/// Installs the layout global at its default. Idempotent across windows: a
/// layout already installed is kept.
pub fn init(cx: &mut App) {
	if !cx.has_global::<WorkspaceLayout>() {
		cx.set_global(WorkspaceLayout::default());
	}
}

impl Workspace {
	/// Lays out `regions` with the sizes and visibility `store` records, and
	/// takes keyboard focus when nothing in `window` holds it.
	pub fn new(
		app: Entity<AppState>,
		regions: Regions,
		store: PanelsStore,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Self {
		init(cx);
		let mut restored = WorkspaceLayout::get(cx).clone();
		let sizes = Sizes::restore(&store, &mut restored);
		WorkspaceLayout::update(cx, |layout| *layout = restored.clone());
		let observe = cx.observe_global_in::<WorkspaceLayout>(window, Self::layout_changed);
		let store_changed = cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
			StoreEvent::NotificationsChanged => this.notices.sync(&this.app, cx),
			StoreEvent::ConnectionChanged => cx.notify(),
			StoreEvent::ActiveSessionChanged => this.session_changed(cx),
			_ => {},
		});
		let (mut notices, dismissed) = Notices::new(cx);
		notices.sync(&app, cx);
		let banner = cx.new(|cx| ConnectionBanner::new(app.clone(), cx));
		let empty = cx.new(|cx| EmptyState::new(app.clone(), cx));
		let focus = cx.focus_handle();
		if window.focused(cx).is_none() {
			window.focus(&focus, cx);
		}
		Self {
			app,
			regions,
			sizes,
			slides: Slides::new(&restored),
			shown: restored,
			store,
			focus,
			notices,
			banner,
			empty,
			_subscriptions: [observe, store_changed, dismissed],
		}
	}

	/// The stack the announcement queue is drawn in.
	pub const fn toasts(&self) -> &Entity<Toasts> {
		self.notices.toasts()
	}

	/// The sizes the regions open to.
	pub const fn sizes(&self) -> Sizes {
		self.sizes
	}

	/// The persisted layout: the store the workspace opened with, updated with
	/// the current sizes and visibility.
	pub fn panels_store(&self, cx: &App) -> PanelsStore {
		let mut store = self.store.clone();
		self.sizes.record(WorkspaceLayout::get(cx), &mut store);
		store
	}

	/// Lays the regions out as the newly displayed session last had them. A
	/// session with no layout of its own keeps the one on screen.
	fn session_changed(&mut self, cx: &mut Context<Self>) {
		let store = {
			let app = self.app.read(cx);
			app.active_session()
				.and_then(|session| app.store().persisted.panels.get(session))
				.cloned()
		};
		if let Some(store) = store {
			let mut layout = WorkspaceLayout::get(cx).clone();
			self.sizes = Sizes::restore(&store, &mut layout);
			self.store = store;
			WorkspaceLayout::update(cx, |current| *current = layout);
		}
		cx.notify();
	}

	/// Slides the regions whose visibility changed, moves focus to what the
	/// change opened, and reports the new layout.
	fn layout_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let next = WorkspaceLayout::get(cx).clone();
		if next == self.shown {
			return;
		}
		self.slides.retarget(&self.shown, &next, cx);
		if next.palette_open && !self.shown.palette_open {
			focus_slot(FocusSlot::Palette, window, cx);
		} else if !next.palette_open && self.shown.palette_open && !next.settings_open {
			self.focus_composer(window, cx);
		}
		self.shown = next;
		self.report(cx);
		cx.notify();
	}

	/// Focuses the composer, or the workspace itself while no composer is
	/// registered, so the window's bindings keep working.
	fn focus_composer(&self, window: &mut Window, cx: &mut App) {
		if !focus_slot(FocusSlot::Composer, window, cx) {
			window.focus(&self.focus, cx);
		}
	}

	fn report(&self, cx: &mut Context<Self>) {
		cx.emit(WorkspaceEvent::LayoutChanged(self.panels_store(cx)));
	}
}
