//! The right panel: a strip of six tabs over the session's changes, files,
//! agents, plan, diagnostics and usage.
//!
//! [`RightPanel`] draws the strip and the active tab. The diff, files and
//! agents tabs are entities of their own that hold what they derive (parsed
//! rows, highlighted text, an expanded tree) and notify themselves for the
//! host domains they draw; the plan, diagnostics and usage tabs are drawn
//! straight from the store, and the panel notifies itself only when the
//! active one of them draws the domain that changed. A streamed turn changes
//! no domain the panel draws, so it renders the panel zero times.

pub mod agents;
pub mod diagnostics;
pub mod diff;
pub mod files;
mod sideways;
pub mod style;
pub mod tab;
pub mod todo;
pub mod usage;

use std::rc::Rc;

use veyyon_desktop_model::{DiffMode, HostAction, RequestId, SnapshotSectionKind, SurfaceId};
use veyyon_desktop_ui::{
	overlays::{Tabs, TabsEvent},
	theme::ActiveTheme,
};
use veyyon_gpui::{
	App, Context, Entity, FocusHandle, Focusable, Global, IntoElement, ParentElement, Render,
	SharedString, Styled, Subscription, WeakEntity, Window, div, prelude::*,
};

pub use self::tab::PanelTab;
use self::{agents::AgentsView, diff::DiffView, files::FilesView};
use crate::{AppState, StoreEvent, actions::panel as act, driver, workspace::WorkspaceLayout};

/// The panel the App-level panel actions reach.
struct PanelHandle(WeakEntity<RightPanel>);

impl Global for PanelHandle {}

/// Registers the panel's App-level action listeners, so a binding, the
/// palette or a link reaches the panel wherever the focus is.
pub fn init(cx: &mut App) {
	on(cx, |action: &act::OpenFile, panel, cx| {
		panel.open_file(action.path.clone(), action.line, cx);
	});
	on(cx, |_: &act::NextTab, panel, cx| panel.step(1, cx));
	on(cx, |_: &act::PreviousTab, panel, cx| panel.step(-1, cx));
	on(cx, |_: &act::ToggleDiffMode, panel, cx| panel.toggle_diff_mode(cx));
}

/// Runs `run` on the window's panel when `A` is dispatched.
fn on<A: gpui::Action>(
	cx: &mut App,
	run: impl Fn(&A, &mut RightPanel, &mut Context<RightPanel>) + 'static,
) {
	cx.on_action(move |action: &A, cx| {
		if let Some(panel) = cx
			.try_global::<PanelHandle>()
			.and_then(|handle| handle.0.upgrade())
		{
			panel.update(cx, |panel, cx| run(action, panel, cx));
		}
	});
}

/// The right panel region.
pub struct RightPanel {
	app:            Entity<AppState>,
	tabs:           Entity<Tabs>,
	active:         PanelTab,
	diff:           Entity<DiffView>,
	files:          Entity<FilesView>,
	agents:         Entity<AgentsView>,
	/// The requests the panel's own controls sent and the host has not
	/// answered, whose answer ends a spinner the panel draws.
	awaiting:       Vec<RequestId>,
	/// Whether the panel is open, as the layout last stated.
	open:           bool,
	focus:          FocusHandle,
	renders:        u64,
	_subscriptions: Vec<Subscription>,
}

impl RightPanel {
	/// Builds the panel over `app`, on the tab the displayed session was left
	/// on.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let active = persisted_tab(app.read(cx));
		let tabs = cx.new(|cx| {
			let mut tabs = Tabs::new(tab::items(app.read(cx)), active.index(), cx);
			tabs.set_tab_wrapper(
				Some(Rc::new(|ix, element| match PanelTab::ALL.get(ix) {
					Some(tab) => driver::target(("panel.tab", tab.name()), element),
					None => element,
				})),
				cx,
			);
			tabs
		});
		let diff = cx.new(|cx| DiffView::new(app.clone(), window, cx));
		let files = cx.new(|cx| FilesView::new(app.clone(), window, cx));
		let agents = cx.new(|cx| AgentsView::new(app.clone(), window, cx));
		let subscriptions = vec![
			cx.subscribe(&tabs, |this, _, event: &TabsEvent, cx| {
				if let TabsEvent::Selected(ix) = *event
					&& let Some(&tab) = PanelTab::ALL.get(ix)
				{
					this.show(tab, cx);
				}
			}),
			cx.subscribe(&app, Self::on_store_event),
			cx.observe_global_in::<WorkspaceLayout>(window, Self::follow_layout),
		];
		cx.set_global(PanelHandle(cx.entity().downgrade()));
		let mut panel = Self {
			app,
			tabs,
			active,
			diff,
			files,
			agents,
			awaiting: Vec::new(),
			open: WorkspaceLayout::get(cx).panel_open,
			focus: cx.focus_handle(),
			renders: 0,
			_subscriptions: subscriptions,
		};
		panel.load(active, cx);
		Self::publish(active, cx);
		panel
	}

	/// The tab the panel shows.
	pub const fn active(&self) -> PanelTab {
		self.active
	}

	/// How many times the panel has rendered, which a view test compares
	/// across a streamed turn.
	pub const fn render_count(&self) -> u64 {
		self.renders
	}

	/// The diff tab's view.
	pub const fn diff(&self) -> &Entity<DiffView> {
		&self.diff
	}

	/// The files tab's view.
	pub const fn files(&self) -> &Entity<FilesView> {
		&self.files
	}

	/// Shows `tab`, records it as the displayed session's tab and asks the
	/// host for what it draws when nothing has arrived yet.
	pub fn show(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
		if tab != self.active {
			self.active = tab;
			self
				.tabs
				.update(cx, |tabs, cx| tabs.set_tabs(tab::items(self.app.read(cx)), tab.index(), cx));
			self
				.app
				.update(cx, |app, _| app.set_active_right_tab(tab.name()));
			cx.notify();
		}
		Self::publish(tab, cx);
		self.load(tab, cx);
	}

	/// Writes `tab` into the layout, so a `workspace::ShowPanelTab` naming
	/// the tab the panel already shows is not taken for no change.
	fn publish(tab: PanelTab, cx: &mut Context<Self>) {
		WorkspaceLayout::update(cx, |layout| {
			layout.panel_tab = SharedString::new_static(tab.name());
		});
	}

	/// Shows the tab the layout names when a `workspace::ShowPanelTab` moved
	/// it, and asks for what the shown tab draws when the panel opens; any
	/// other change of the layout draws nothing here.
	fn follow_layout(&mut self, _: &mut Window, cx: &mut Context<Self>) {
		let layout = WorkspaceLayout::get(cx);
		let named = PanelTab::from_name(&layout.panel_tab);
		let opened = layout.panel_open && !self.open;
		self.open = layout.panel_open;
		if let Some(tab) = named.filter(|tab| *tab != self.active) {
			self.show(tab, cx);
		} else if opened {
			self.load(self.active, cx);
		}
	}

	/// Shows the tab persisted under `name`; an unknown name changes nothing.
	pub fn show_named(&mut self, name: &str, cx: &mut Context<Self>) {
		if let Some(tab) = PanelTab::from_name(name) {
			self.show(tab, cx);
		}
	}

	/// Shows `path` in the files tab, scrolled to `line`, and asks the host
	/// for its text; an empty `path` shows the tab on its tree.
	pub fn open_file(&mut self, path: String, line: Option<u32>, cx: &mut Context<Self>) {
		self.show(PanelTab::Files, cx);
		if !path.is_empty() {
			self
				.files
				.update(cx, |files, cx| files.open(path, line, cx));
		}
		WorkspaceLayout::update(cx, |layout| layout.panel_open = true);
	}

	/// Sends `action` for the control `surface` and draws the control
	/// waiting until the host answers.
	fn send(&mut self, action: HostAction, surface: SurfaceId, cx: &mut Context<Self>) {
		let request = self
			.app
			.update(cx, |app, cx| app.dispatch(action, surface, cx));
		self.awaiting.push(request);
		cx.notify();
	}

	/// Asks the host for the domain `tab` draws when the panel is open, it
	/// has none to show, the host takes the request and none is in flight.
	fn load(&mut self, tab: PanelTab, cx: &mut Context<Self>) {
		if !self.open {
			return;
		}
		let app = self.app.read(cx);
		let session = app.active_session().cloned();
		let domains = &app.store().domains;
		let request = match tab {
			PanelTab::Diff if !domains.changes.is_some() => {
				session.map(|s| (HostAction::RefreshChanges, SurfaceId::RightPanelDiffTab(s)))
			},
			PanelTab::Files if domains.file_tree.is_none() => session
				.map(|s| (HostAction::LoadFileTree { root: None }, SurfaceId::RightPanelFileTab(s))),
			PanelTab::Agents if domains.agents.is_empty() => {
				Some((HostAction::RefreshAgents, SurfaceId::TaskSpawnButton))
			},
			PanelTab::Diagnostics if domains.diagnostics.is_none() => {
				Some((HostAction::RefreshDiagnostics, SurfaceId::DiagnosticRefreshButton))
			},
			PanelTab::Usage => session
				.filter(|s| !domains.usage.contains_key(s) || !domains.context.contains_key(s))
				.map(|session| {
					(HostAction::GetUsage { session: Some(session) }, SurfaceId::UsageRefreshButton)
				}),
			_ => None,
		}
		.filter(|(action, _)| {
			!app.panel_pending(action.kind()) && app.panel_unavailable(action.kind()).is_none()
		});
		match request {
			Some((HostAction::GetUsage { session: Some(session) }, _)) => {
				self.refresh_usage(&session, cx);
			},
			Some((action, surface)) => self.send(action, surface, cx),
			None => {},
		}
	}

	fn on_store_event(&mut self, _: Entity<AppState>, event: &StoreEvent, cx: &mut Context<Self>) {
		match event {
			StoreEvent::DomainChanged(kind) => {
				if matches!(kind, SnapshotSectionKind::Changes | SnapshotSectionKind::Agents) {
					let items = tab::items(self.app.read(cx));
					let selected = self.active.index();
					self
						.tabs
						.update(cx, |tabs, cx| tabs.set_tabs(items, selected, cx));
				}
				if self.active.draws(*kind) && self.active.drawn_inline() {
					cx.notify();
				}
				if *kind == SnapshotSectionKind::Capabilities {
					// A host that takes what it declined is asked for what the
					// shown tab draws.
					self.load(self.active, cx);
				}
			},
			StoreEvent::ActiveSessionChanged => {
				let tab = persisted_tab(self.app.read(cx));
				self.active = tab;
				let items = tab::items(self.app.read(cx));
				self
					.tabs
					.update(cx, |tabs, cx| tabs.set_tabs(items, tab.index(), cx));
				Self::publish(tab, cx);
				self.load(tab, cx);
				cx.notify();
			},
			StoreEvent::RequestFinished { request, .. } => {
				if let Some(ix) = self.awaiting.iter().position(|awaited| awaited == request) {
					self.awaiting.swap_remove(ix);
					cx.notify();
				}
			},
			_ => {},
		}
	}

	fn step(&mut self, delta: isize, cx: &mut Context<Self>) {
		let len = PanelTab::ALL.len() as isize;
		let ix = (self.active.index() as isize + delta).rem_euclid(len) as usize;
		if let Some(&tab) = PanelTab::ALL.get(ix) {
			self.show(tab, cx);
		}
	}

	fn toggle_diff_mode(&self, cx: &mut Context<Self>) {
		self.app.update(cx, |app, _| {
			let next = match app.diff_mode() {
				DiffMode::Unified => DiffMode::Split,
				DiffMode::Split => DiffMode::Unified,
			};
			app.set_diff_mode(next);
		});
		self.diff.update(cx, |diff, cx| diff.relayout(cx));
	}
}

impl PanelTab {
	/// Whether the panel draws this tab itself rather than through a child
	/// entity that notifies on its own.
	const fn drawn_inline(self) -> bool {
		matches!(self, Self::Todo | Self::Diagnostics | Self::Usage)
	}
}

/// The tab the displayed session was left on, the diff for one never
/// changed.
fn persisted_tab(app: &AppState) -> PanelTab {
	app.active_right_tab()
		.and_then(PanelTab::from_name)
		.unwrap_or(PanelTab::Diff)
}

impl Focusable for RightPanel {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for RightPanel {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let content = match self.active {
			PanelTab::Diff => self.diff.clone().into_any_element(),
			PanelTab::Files => self.files.clone().into_any_element(),
			PanelTab::Agents => self.agents.clone().into_any_element(),
			PanelTab::Todo => todo::render(self.app.read(cx), &palette),
			PanelTab::Diagnostics => diagnostics::render(self, &palette, cx),
			PanelTab::Usage => usage::render(self, &palette, cx),
		};
		// The workspace registers the `panel` target around this region.
		div()
			.id("panel")
			.track_focus(&self.focus)
			.key_context("Panel")
			.flex()
			.flex_col()
			.size_full()
			.min_w_0()
			.overflow_hidden()
			.bg(palette.bg.sidebar)
			.border_l_1()
			.border_color(palette.border.subtle)
			.child(self.tabs.clone())
			.child(div().flex().flex_col().flex_1().min_h_0().child(content))
	}
}
