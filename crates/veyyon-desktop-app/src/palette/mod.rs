//! The command palette: one ranked list of every window action, every slash
//! command the host advertises, every thread, the files the host matched and
//! every settings page.
//!
//! The palette stays mounted while closed so its close motion can run. It
//! follows [`WorkspaceLayout::palette_open`]: the workspace actions open and
//! close it through the layout, and the palette writes the layout back when
//! it closes itself, emitting [`PaletteEvent::Dismissed`].

mod item;
mod matcher;
mod motion;
mod rank;
mod requests;
mod run;
mod sources;
mod view;

use veyyon_desktop_model::{HostAction, SnapshotSectionKind, SurfaceId};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	theme::text,
};
use veyyon_gpui::{
	App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ScrollHandle,
	Subscription, Window,
};

pub use self::{
	item::{ActionData, Group, Hint, Item, Run, Takes},
	matcher::Query,
	motion::Phase,
	sources::{Scope, refusal, refusal_kind},
};
use self::{motion::Presence, rank::rank};
use crate::{
	actions::workspace,
	state::{AppState, StoreEvent},
	workspace::{FocusSlot, WorkspaceLayout, register_focus},
};

/// The input's placeholder at the root of the palette.
const PLACEHOLDER: &str = "Search commands, threads, files and settings";

/// What the palette reports to the workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaletteEvent {
	/// The palette started closing: a row ran, Escape was pressed, or a click
	/// landed outside it.
	Dismissed,
}

/// The command palette region.
pub struct CommandPalette {
	app:            Entity<AppState>,
	input:          Entity<Editor>,
	presence:       Presence,
	scope:          Scope,
	items:          Vec<Item>,
	shown:          Vec<usize>,
	selected:       usize,
	return_focus:   Option<FocusHandle>,
	list:           ScrollHandle,
	renders:        usize,
	/// How many row targets the last frame drew, so fewer can forget the rest.
	drawn_rows:     usize,
	_subscriptions: [Subscription; 3],
}

impl EventEmitter<PaletteEvent> for CommandPalette {}

impl CommandPalette {
	/// A closed palette over `app`.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let input = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_placeholder(PLACEHOLDER, cx);
			editor.set_text_style(text::BODY, cx);
			editor
		});
		register_focus(FocusSlot::Palette, &input.focus_handle(cx), cx);
		let subscriptions = [
			cx.subscribe_in(&input, window, |this, _, event: &EditorEvent, window, cx| {
				this.on_input(*event, window, cx);
			}),
			cx.subscribe_in(&app, window, Self::on_store),
			cx.observe_global_in::<WorkspaceLayout>(window, Self::on_layout),
		];
		Self {
			app,
			input,
			presence: Presence::new(),
			scope: Scope::Root,
			items: Vec::new(),
			shown: Vec::new(),
			selected: 0,
			return_focus: None,
			list: ScrollHandle::new(),
			renders: 0,
			drawn_rows: 0,
			_subscriptions: subscriptions,
		}
	}

	/// Whether the palette takes input. A closing palette does not.
	pub fn is_open(&self) -> bool {
		self.presence.phase() == Phase::Open
	}

	/// The rows drawn, in order.
	pub fn shown(&self) -> impl Iterator<Item = &Item> {
		self.shown.iter().filter_map(|ix| self.items.get(*ix))
	}

	/// The index among [`shown`](Self::shown) of the highlighted row.
	pub const fn selected(&self) -> usize {
		self.selected
	}

	/// How many times the palette has rendered.
	pub const fn render_count(&self) -> usize {
		self.renders
	}

	/// What the palette lists.
	pub const fn scope(&self) -> &Scope {
		&self.scope
	}

	/// Opens the palette at its root with an empty query, and asks the host
	/// for its slash commands when it has sent none.
	pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if !self.is_open() {
			self.return_focus = window.focused(cx);
		}
		self.scope = Scope::Root;
		self.set_query("", PLACEHOLDER, window, cx);
		self.presence.open(cx);
		if !WorkspaceLayout::get(cx).palette_open {
			window.dispatch_action(Box::new(workspace::OpenPalette), cx);
		}
		if self.app.read(cx).store().domains.commands.is_empty() {
			self.app.update(cx, |app, cx| {
				app.dispatch(HostAction::ListCommands, SurfaceId::PaletteInput, cx);
			});
		}
		self.input.update(cx, |input, cx| input.focus(window, cx));
		cx.notify();
	}

	/// Starts closing, returns focus to where it was and emits
	/// [`PaletteEvent::Dismissed`]. Does nothing unless the palette is open.
	pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if !self.is_open() {
			return;
		}
		self.presence.close(cx);
		if WorkspaceLayout::get(cx).palette_open {
			window.dispatch_action(Box::new(workspace::ClosePalette), cx);
		}
		if let Some(focus) = self.return_focus.take() {
			window.focus(&focus, cx);
		}
		cx.emit(PaletteEvent::Dismissed);
		cx.notify();
	}

	/// Opens a closed palette and closes an open one.
	pub fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.is_open() {
			self.close(window, cx);
		} else {
			self.open(window, cx);
		}
	}

	/// Opens or closes to match the layout.
	fn on_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let open = WorkspaceLayout::get(cx).palette_open;
		if open != self.is_open() {
			self.toggle(window, cx);
		}
	}

	/// Moves the highlight one row down, or up, wrapping at either end.
	pub fn move_selection(&mut self, down: bool, cx: &mut Context<Self>) {
		let count = self.shown.len();
		if count == 0 {
			return;
		}
		self.selected = if down {
			(self.selected + 1) % count
		} else {
			(self.selected + count - 1) % count
		};
		self.list.scroll_to_item(self.child_index(self.selected));
		cx.notify();
	}

	/// The index among the list's children of shown row `row`: the rows
	/// before it plus a heading per section up to and including its own.
	fn child_index(&self, row: usize) -> usize {
		let mut headings = 0;
		let mut section = None;
		for ix in self.shown.iter().take(row + 1) {
			let group = self.items.get(*ix).map(|item| item.group);
			if group != section {
				section = group;
				headings += 1;
			}
		}
		row + headings
	}

	/// Runs the highlighted row, or the argument typed for a command.
	pub fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if let Scope::Argument { line, takes, .. } = &self.scope {
			let run = Run::Filled {
				takes: *takes,
				line:  line.clone(),
				text:  self.input.read(cx).text().trim().to_owned(),
			};
			self.run(run, window, cx);
			return;
		}
		self.choose(self.selected, window, cx);
	}

	/// Runs the row at `ix` among [`shown`](Self::shown), unless it is
	/// blocked.
	pub fn choose(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
		let Some(item) = self.shown.get(ix).and_then(|ix| self.items.get(*ix)) else {
			return;
		};
		if item.blocked.is_some() {
			return;
		}
		let run = item.run.clone();
		self.run(run, window, cx);
	}

	/// Escape: leaves a subcommand list or an argument for the root, and
	/// closes the palette at the root.
	pub fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.scope == Scope::Root {
			self.close(window, cx);
		} else {
			self.enter(Scope::Root, window, cx);
		}
	}

	/// Lists `scope` with an empty query.
	fn enter(&mut self, scope: Scope, window: &Window, cx: &mut Context<Self>) {
		let placeholder = match &scope {
			Scope::Root => PLACEHOLDER.to_owned(),
			Scope::Subcommands(name) => format!("Subcommands of /{name}"),
			Scope::Argument { line, hint, .. } => format!("{line}{hint}"),
		};
		self.scope = scope;
		self.set_query("", &placeholder, window, cx);
		cx.notify();
	}

	fn set_query(
		&mut self,
		query: &str,
		placeholder: &str,
		window: &Window,
		cx: &mut Context<Self>,
	) {
		self.input.update(cx, |input, cx| {
			input.set_text(query, cx);
			input.set_placeholder(placeholder.to_owned(), cx);
		});
		self.refresh(window, cx);
	}

	/// Rebuilds the rows from the store and ranks them against the query.
	fn refresh(&mut self, window: &Window, cx: &Context<Self>) {
		let query = self.input.read(cx).text().to_owned();
		self.items = sources::collect(&self.scope, &query, self.app.read(cx), window);
		self.shown = rank(&self.items, &Query::new(&query));
		self.selected = 0;
		self.list.scroll_to_item(0);
	}

	fn on_input(&mut self, event: EditorEvent, window: &mut Window, cx: &mut Context<Self>) {
		if !self.is_open() {
			return;
		}
		match event {
			EditorEvent::Changed => {
				self.refresh(window, cx);
				self.search_files(cx);
				cx.notify();
			},
			EditorEvent::Submit => self.confirm(window, cx),
			EditorEvent::Escape => self.back(window, cx),
			EditorEvent::Focused
			| EditorEvent::Blurred
			| EditorEvent::HistoryPrev
			| EditorEvent::HistoryNext => {},
		}
	}

	/// Asks the host for the files whose names match the query.
	fn search_files(&self, cx: &mut Context<Self>) {
		if self.scope != Scope::Root {
			return;
		}
		let query = self.input.read(cx).text().trim().to_owned();
		if query.is_empty() {
			return;
		}
		self.app.update(cx, |app, cx| {
			app.dispatch(HostAction::SearchFiles { query }, SurfaceId::PaletteInput, cx);
		});
	}

	/// Re-lists the rows when a section the palette lists changed while it is
	/// open. A closed palette rebuilds when it opens.
	fn on_store(
		&mut self,
		_: &Entity<AppState>,
		event: &StoreEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if !self.is_open() {
			return;
		}
		let listed = matches!(
			event,
			StoreEvent::SessionsChanged
				| StoreEvent::ConnectionChanged
				| StoreEvent::DomainChanged(
					SnapshotSectionKind::Commands
						| SnapshotSectionKind::SearchResults
						| SnapshotSectionKind::Capabilities
				)
		);
		if listed {
			let selected = self.selected;
			self.refresh(window, cx);
			self.selected = selected.min(self.shown.len().saturating_sub(1));
			cx.notify();
		}
	}
}

impl Focusable for CommandPalette {
	fn focus_handle(&self, cx: &App) -> FocusHandle {
		self.input.focus_handle(cx)
	}
}
