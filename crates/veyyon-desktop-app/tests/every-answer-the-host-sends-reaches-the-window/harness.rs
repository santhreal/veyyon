//! A whole window, every region real over one `AppState` fed host events,
//! and the ways the sweep reaches the surface a section is drawn on.

use std::time::Duration;

use gpui::{
	Action, AppContext as _, Entity, Modifiers, TestAppContext, VisualTestContext, px, size,
};
use veyyon_desktop_app::{
	AppState,
	drawer::TerminalDrawer,
	driver, keymap,
	palette::CommandPalette,
	panel::RightPanel,
	settings::SettingsView,
	sidebar::Sidebar,
	thread::ThreadView,
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{HostAction, HostEvent, PanelsStore, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window every section is drawn in: tall and wide enough that a settings
/// page, the panel and the drawer are laid out whole beside the thread.
const WINDOW: (f32, f32) = (1600.0, 1200.0);

pub struct Win<'a> {
	pub state:  Entity<AppState>,
	pub panel:  Entity<RightPanel>,
	pub drawer: Entity<TerminalDrawer>,
	pub cx:     &'a mut VisualTestContext,
}

/// Installs the theme, the app's App-level listeners and the keymap, once
/// for every window the test opens.
pub fn install(app: &TestAppContext) {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(true);
	});
}

/// Opens a window at the default layout over a store fed `events`, and drops
/// the requests the events and the regions queued.
pub fn window(app: &mut TestAppContext, events: Vec<HostEvent>) -> Win<'_> {
	// The layout is App-wide; each window starts from the default rather
	// than from the regions the window before it opened.
	app.update(|cx| cx.set_global(WorkspaceLayout::default()));
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(events, cx));
	let shared = state.clone();
	let mut built = None;
	let (_, cx) = app.add_window_view(|window, cx| {
		let panel = cx.new(|cx| RightPanel::new(shared.clone(), window, cx));
		let drawer = cx.new(|cx| TerminalDrawer::new(shared.clone(), window, cx));
		built = Some((panel.clone(), drawer.clone()));
		let regions = Regions {
			sidebar:  cx.new(|cx| Sidebar::new(shared.clone(), window, cx)).into(),
			thread:   cx
				.new(|cx| ThreadView::new(shared.clone(), window, cx))
				.into(),
			panel:    panel.into(),
			drawer:   drawer.into(),
			palette:  cx
				.new(|cx| CommandPalette::new(shared.clone(), window, cx))
				.into(),
			settings: cx
				.new(|cx| SettingsView::new(shared.clone(), window, cx))
				.into(),
		};
		Workspace::new(shared.clone(), regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let (panel, drawer) = built.expect("the window built its regions");
	state.update(cx, |state, _| state.drain_outbox());
	Win { state, panel, drawer, cx }
}

impl Win<'_> {
	/// Searches the files tab for `query`, as Enter in its field does.
	pub fn search_files(&mut self, query: &str) {
		let files = self
			.panel
			.read_with(&*self.cx, |panel, _| panel.files().clone());
		self
			.cx
			.update(|window, cx| files.update(cx, |files, cx| files.search(query, window, cx)));
		self.cx.run_until_parked();
	}

	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	pub fn dispatch(&mut self, action: impl Action) {
		self.cx.dispatch_action(action);
		self.cx.run_until_parked();
	}

	/// Types `text` into whatever holds the keys.
	pub fn typed(&mut self, text: &str) {
		self.cx.simulate_input(text);
		self.cx.run_until_parked();
	}

	/// Lets `time` pass, so a pause the window waits out elapses.
	pub fn wait(&self, time: Duration) {
		self.cx.executor().advance_clock(time);
		self.cx.run_until_parked();
	}

	/// Every request queued since the last drain.
	pub fn outbox(&mut self) -> Vec<HostAction> {
		self.state.update(self.cx, |state, _| {
			state
				.drain_outbox()
				.into_iter()
				.map(|request| request.action)
				.collect()
		})
	}

	/// The text the last frame drew, in paint order.
	pub fn texts(&mut self) -> Vec<String> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| run.text.to_string())
				.collect()
		})
	}

	/// Clicks the centre of the first run a fresh frame draws reading `text`.
	pub fn click_text(&mut self, text: &str) {
		self.cx.update(|window, _| window.refresh());
		self.cx.run_until_parked();
		let at = self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.find(|run| run.text.as_ref() == text)
				.map(|run| run.bounds.center())
		});
		let at = at.unwrap_or_else(|| panic!("the window draws {text:?}"));
		self.cx.simulate_click(at, Modifiers::none());
		self.cx.run_until_parked();
	}
}
