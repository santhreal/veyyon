//! The terminal drawer: a strip of tabs over the host's terminals, the
//! processes its supervisor runs, and the output of each process.
//!
//! A terminal tab draws its emulator's grid and writes every key the grid
//! takes to the terminal. The processes tab lists what the supervisor runs,
//! with the controls that start, stop, restart and signal a process; a
//! process tab draws that process's output and a field that writes a line to
//! it. The drawer feeds an emulator only while it is open and only for the
//! tab it shows, so output streaming into a hidden terminal costs nothing
//! until the tab is shown, when the emulator replays the retained tail.

mod bindings;
mod command;
mod controls;
mod events;
mod grid;
mod ink;
mod input;
mod processes;
mod refusal;
mod render;
mod rows;
mod screen;
mod strip;
mod supervisor;
mod tabs;
mod terminal;

use std::{
	cell::{Cell, RefCell},
	collections::{HashMap, HashSet},
	rc::Rc,
};

use veyyon_desktop_model::{HostAction, HostActionKind, RequestId, SessionId, SurfaceId};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	overlays::{ContextMenu, MenuEvent, Tabs},
};
use veyyon_gpui::{
	App, AppContext as _, Bounds, Context, Entity, FocusHandle, Pixels, SharedString, Size,
	Subscription, Window,
};

use self::bindings::DrawerHandle;
pub use self::{
	bindings::init,
	command::split_command_line,
	input::{keystroke_bytes, paste_bytes},
	processes::SIGNALS,
	rows::{RowText, row_text},
	screen::Screen,
	tabs::DrawerTab,
};
use crate::{AppState, workspace::WorkspaceLayout};

/// The terminal drawer region.
pub struct TerminalDrawer {
	app:            Entity<AppState>,
	tabs:           Entity<Tabs>,
	/// The tabs the strip holds, in strip order.
	strip:          Vec<DrawerTab>,
	/// The tab the operator picked; the drawer falls back while it is gone.
	chosen:         Option<DrawerTab>,
	screens:        HashMap<DrawerTab, Screen>,
	/// The columns and rows the grid's box holds, once a frame measured it.
	cells:          Option<(u16, u16)>,
	/// The tab whose box `cells` measured. A process tab's box is shorter
	/// than a terminal's, so a measure holds only for the tab it was taken on.
	measured:       Option<DrawerTab>,
	/// The size each terminal was last told.
	told:           HashMap<String, (u16, u16)>,
	/// The terminals whose output the host streams to the drawer.
	attached:       HashSet<String>,
	/// The processes whose output the host streams to the drawer.
	following:      HashSet<String>,
	/// A terminal was asked for, and the next one to arrive is shown.
	creating:       bool,
	/// The requests the drawer's controls sent and the host has not answered.
	awaiting:       Vec<(RequestId, SurfaceId)>,
	/// The control whose request the host refused last.
	refused:        Option<SurfaceId>,
	/// One cell of the mono face.
	cell:           Option<Size<Pixels>>,
	/// Where the last frame laid the grid's box.
	grid_box:       Rc<Cell<Option<Bounds<Pixels>>>>,
	/// The cell a drag started selecting from.
	anchor:         Option<(usize, usize)>,
	/// Wheel travel not yet a whole row.
	wheel:          Pixels,
	/// What the supervisor's start field holds.
	command:        Entity<Editor>,
	/// What a process tab's field writes to the process.
	line:           Entity<Editor>,
	signals:        Entity<ContextMenu>,
	/// The process the signal menu was opened for.
	signalled:      Option<String>,
	focus:          FocusHandle,
	/// Whether the drawer is open, as the layout last stated.
	open:           bool,
	renders:        u64,
	/// The driver targets the render in progress drew.
	noted:          RefCell<HashSet<SharedString>>,
	/// The driver targets the last render drew, forgotten once not drawn.
	drawn:          HashSet<SharedString>,
	_subscriptions: Vec<Subscription>,
}

impl TerminalDrawer {
	/// Builds the drawer over `app`, on the tab the displayed session was
	/// left on.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let chosen = persisted(app.read(cx));
		let tabs = cx.new(|cx| Tabs::new(Vec::new(), 0, cx));
		let command = field("Command to start, as `bun run dev`", window, cx);
		let line = field("A line to write to the process", window, cx);
		let signals = cx.new(|cx| ContextMenu::new(processes::signal_items(), window, cx));
		let subscriptions = vec![
			cx.subscribe_in(&tabs, window, Self::on_tabs_event),
			cx.subscribe_in(&app, window, Self::on_store_event),
			cx.observe_global_in::<WorkspaceLayout>(window, Self::follow_layout),
			cx.subscribe(&command, |this, _, event: &EditorEvent, cx| {
				if *event == EditorEvent::Submit {
					this.start(cx);
				}
			}),
			cx.subscribe(&line, |this, _, event: &EditorEvent, cx| {
				if *event == EditorEvent::Submit {
					this.send_line(cx);
				}
			}),
			cx.subscribe(&signals, |this, _, event: &MenuEvent, cx| this.on_signal_picked(*event, cx)),
		];
		let handle = DrawerHandle(cx.entity().downgrade());
		cx.set_global(handle);
		let mut drawer = Self {
			app,
			tabs,
			strip: Vec::new(),
			chosen,
			screens: HashMap::new(),
			cells: None,
			measured: None,
			told: HashMap::new(),
			attached: HashSet::new(),
			following: HashSet::new(),
			creating: false,
			awaiting: Vec::new(),
			refused: None,
			cell: grid::cell_size(window),
			grid_box: Rc::default(),
			anchor: None,
			wheel: Pixels::ZERO,
			command,
			line,
			signals,
			signalled: None,
			focus: cx.focus_handle(),
			open: false,
			renders: 0,
			noted: RefCell::default(),
			drawn: HashSet::new(),
			_subscriptions: subscriptions,
		};
		drawer.sync_strip(cx);
		if WorkspaceLayout::get(cx).drawer_open {
			drawer.opened(window, cx);
		}
		drawer
	}

	/// How many times the drawer has rendered, which a view test compares
	/// across a streamed turn.
	pub const fn render_count(&self) -> u64 {
		self.renders
	}

	/// The tabs the strip holds, in strip order.
	pub fn strip(&self) -> &[DrawerTab] {
		&self.strip
	}

	/// The tab the drawer shows. While a terminal it asked for is on its way
	/// and no process tab was picked, only a terminal is shown: the drawer
	/// waits for the terminal rather than falling back to the process list.
	pub fn shown(&self, cx: &App) -> Option<DrawerTab> {
		let shown = tabs::shown(self.app.read(cx), self.chosen.as_ref());
		let waiting = self.creating
			&& !matches!(self.chosen, Some(DrawerTab::Processes | DrawerTab::Process(_)));
		shown.filter(|tab| !waiting || matches!(tab, DrawerTab::Terminal(_)))
	}

	/// The screen of `tab`, once the drawer has shown it.
	pub fn screen(&self, tab: &DrawerTab) -> Option<&Screen> {
		self.screens.get(tab)
	}

	/// The columns and rows the grid's box holds, once a frame measured it.
	pub const fn cells(&self) -> Option<(u16, u16)> {
		self.cells
	}

	/// Shows `tab` and records it as the displayed session's tab.
	pub fn show(&mut self, tab: DrawerTab, cx: &mut Context<Self>) {
		self
			.app
			.update(cx, |app, cx| app.set_active_drawer_tab(&tab.slug(), cx));
		self.chosen = Some(tab);
		self.anchor = None;
		self.refresh_tabs(cx);
		self.enter(cx);
		cx.notify();
	}

	fn step(&mut self, delta: isize, cx: &mut Context<Self>) {
		let Some(shown) = self.shown(cx) else {
			return;
		};
		let len = self.strip.len() as isize;
		let at = self.strip.iter().position(|tab| *tab == shown).unwrap_or(0) as isize;
		if let Some(tab) = self
			.strip
			.get((at + delta).rem_euclid(len.max(1)) as usize)
			.cloned()
		{
			self.show(tab, cx);
		}
	}

	/// Re-reads the strip from the store: drops what the drawer held for a
	/// tab that left it, shows a terminal the drawer asked for once it
	/// arrives, and asks the host for what the shown tab draws.
	fn sync_strip(&mut self, cx: &mut Context<Self>) {
		let strip = tabs::offered(self.app.read(cx));
		if self.creating
			&& let Some(fresh) = strip
				.iter()
				.find(|tab| matches!(tab, DrawerTab::Terminal(_)) && !self.strip.contains(tab))
				.cloned()
		{
			self.creating = false;
			self
				.app
				.update(cx, |app, cx| app.set_active_drawer_tab(&fresh.slug(), cx));
			self.chosen = Some(fresh);
		}
		self.screens.retain(|tab, _| strip.contains(tab));
		let held = |tab: DrawerTab| strip.contains(&tab);
		self
			.attached
			.retain(|id| held(DrawerTab::Terminal(id.clone())));
		self
			.told
			.retain(|id, _| held(DrawerTab::Terminal(id.clone())));
		self
			.following
			.retain(|name| held(DrawerTab::Process(name.clone())));
		self.strip = strip;
		self.refresh_tabs(cx);
		self.enter(cx);
	}

	/// Sets the strip's labels and selection from what the drawer holds.
	fn refresh_tabs(&self, cx: &mut Context<Self>) {
		let shown = self.shown(cx);
		let items = strip::tab_items(self.app.read(cx), &self.strip, &self.screens);
		let selected = shown
			.and_then(|shown| self.strip.iter().position(|tab| *tab == shown))
			.unwrap_or(0);
		let wrapper = strip::tab_wrapper(&self.strip);
		self.tabs.update(cx, |tabs, cx| {
			tabs.set_tabs(items, selected, cx);
			tabs.set_tab_wrapper(Some(wrapper), cx);
		});
	}

	/// Asks the host for what the shown tab draws the first time it is shown
	/// while the drawer is open, and feeds its screen what arrived.
	fn enter(&mut self, cx: &mut Context<Self>) {
		if !self.open {
			return;
		}
		let Some(tab) = self.shown(cx) else {
			return;
		};
		let app = self.app.read(cx);
		match &tab {
			DrawerTab::Terminal(id) => {
				if app
					.panel_unavailable(HostActionKind::AttachTerminal)
					.is_none() && self.attached.insert(id.clone())
				{
					let action = HostAction::AttachTerminal { terminal_id: id.clone() };
					let surface = self.surface(cx, SurfaceId::TerminalCreateButton);
					self.send(action, surface, cx);
				}
			},
			DrawerTab::Process(name) => {
				if app.panel_unavailable(HostActionKind::ProcessLogs).is_none()
					&& self.following.insert(name.clone())
				{
					let action = HostAction::ProcessLogs { process_id: name.clone(), follow: true };
					let surface =
						self.surface(cx, |session| SurfaceId::ProcessLogsTab(session, name.clone()));
					self.send(action, surface, cx);
				}
			},
			DrawerTab::Processes => {
				if app.store().domains.processes.is_empty() {
					self.refresh_processes(cx);
				}
			},
		}
		self.catch_up(cx);
		self.fit_shown(cx);
	}

	/// Asks the host again for the processes its supervisor runs.
	fn refresh_processes(&self, cx: &mut Context<Self>) {
		let app = self.app.read(cx);
		let kind = HostActionKind::RefreshProcesses;
		if !app.panel_pending(kind) && app.panel_unavailable(kind).is_none() {
			self.fire(HostAction::RefreshProcesses, cx);
		}
	}

	/// The surface `make` builds for the displayed session; the titlebar
	/// line while none is displayed.
	fn surface(&self, cx: &App, make: impl FnOnce(SessionId) -> SurfaceId) -> SurfaceId {
		self
			.app
			.read(cx)
			.active_session()
			.cloned()
			.map_or(SurfaceId::GlobalTitlebarLine, make)
	}

	/// Sends `action` for the control `surface`, which draws waiting until
	/// the host answers.
	fn send(&mut self, action: HostAction, surface: SurfaceId, cx: &mut Context<Self>) {
		if self.refused.as_ref() == Some(&surface) {
			self.refused = None;
		}
		let request = self
			.app
			.update(cx, |app, cx| app.dispatch(action, surface.clone(), cx));
		self.awaiting.push((request, surface));
		cx.notify();
	}

	/// Sends `action`, which no control draws waiting: a key, a size, a
	/// refresh. The host's refusal of one is the connection's.
	fn fire(&self, action: HostAction, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| {
			app.dispatch(action, SurfaceId::GlobalTitlebarLine, cx);
		});
	}

	/// Whether a request the control `surface` sent is in flight.
	fn waiting(&self, surface: &SurfaceId) -> bool {
		self.awaiting.iter().any(|(_, awaited)| awaited == surface)
	}
}

/// The tab the displayed session was left on.
fn persisted(app: &AppState) -> Option<DrawerTab> {
	app.active_drawer_tab().and_then(DrawerTab::from_slug)
}

/// A one-line field showing `placeholder` while empty.
fn field(
	placeholder: &'static str,
	window: &mut Window,
	cx: &mut Context<TerminalDrawer>,
) -> Entity<Editor> {
	cx.new(|cx| {
		let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
		editor.set_placeholder(placeholder, cx);
		editor
	})
}
