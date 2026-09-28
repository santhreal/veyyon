//! The session tree sheet: a session's entries and what its rows send.
//!
//! The rows are the host's flattened tree, filtered by the terminal's modes. A
//! row's requests move the session's leaf, summarize the branch it leaves and
//! label an entry.
//!
//! The sheet asks for the tree when it opens and draws only its own
//! session's. Which filter shows a row is the host's answer
//! ([`SessionTreeNode::shown_in`]); the sheet does not restate the rules. A
//! navigation the host takes closes the sheet; one it refuses returns to the
//! rows and states the host's reason.

mod keys;
mod rows;
mod steps;

use gpui::{
	App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ScrollStrategy,
	SharedString, Subscription, UniformListScrollHandle, Window,
};
use veyyon_desktop_model::{
	EntryId, HostAction, RequestId, SessionId, SessionTreeFilter, SessionTreeNode, SessionTreeView,
	SnapshotSectionKind, SurfaceId, TreeRequest,
};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	theme::text,
};

use crate::{AppState, StoreEvent};

/// What the sheet reports to the thread column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetEvent {
	/// The sheet closed: Escape on the rows, the close button, or a
	/// navigation the host took.
	Closed,
}

/// Where the sheet is in picking what to do with a row.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
	/// The rows, the keyboard on one of them.
	Browse,
	/// Whether to summarize the branch left for `entry`, the keyboard on
	/// choice `cursor`.
	Summary { entry: EntryId, cursor: usize },
	/// The instructions the summary of the branch left for `entry` follows.
	Instructions { entry: EntryId },
	/// The label to set on `entry`.
	Label { entry: EntryId },
}

/// A navigation the host has not answered.
struct Navigating {
	request:   RequestId,
	summarize: bool,
	/// Escape asked the host to stop the summary.
	aborted:   bool,
}

/// The line under the rows, when it states more than the keys.
enum Status {
	/// A note on the last key pressed.
	Note(&'static str),
	/// The sentence the host gave for refusing a request the sheet sent.
	Refused(SharedString),
}

/// One session's entry tree, browsed with the keyboard or the pointer.
pub struct SessionTreeSheet {
	app:            Entity<AppState>,
	session:        SessionId,
	focus:          FocusHandle,
	/// The field the instructions and the label are written in.
	input:          Entity<Editor>,
	step:           Step,
	/// The filter picked in the sheet, or `None` for the one the host opens
	/// it in.
	filter:         Option<SessionTreeFilter>,
	/// The rows the filter shows, as indices into the tree's nodes.
	shown:          Vec<usize>,
	/// The entry the keyboard is on.
	selected:       Option<EntryId>,
	list:           UniformListScrollHandle,
	/// How many rows the list last laid out, which is what a page moves.
	page:           usize,
	navigating:     Option<Navigating>,
	/// Every other request the sheet sent that the host has not answered.
	sent:           Vec<RequestId>,
	status:         Option<Status>,
	_subscriptions: [Subscription; 2],
}

impl EventEmitter<SheetEvent> for SessionTreeSheet {}

impl SessionTreeSheet {
	/// The sheet for `session`, which takes the keyboard and asks the host
	/// for the session's tree.
	pub fn new(
		app: Entity<AppState>,
		session: SessionId,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Self {
		let input = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_text_style(text::UI, cx);
			editor
		});
		let subscriptions = [
			cx.subscribe_in(&input, window, |this, _, event: &EditorEvent, window, cx| {
				this.on_input(*event, window, cx);
			}),
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| this.on_store(event, cx)),
		];
		let focus = cx.focus_handle();
		window.focus(&focus, cx);
		let mut sheet = Self {
			app,
			session,
			focus,
			input,
			step: Step::Browse,
			filter: None,
			shown: Vec::new(),
			selected: None,
			list: UniformListScrollHandle::new(),
			page: 1,
			navigating: None,
			sent: Vec::new(),
			status: None,
			_subscriptions: subscriptions,
		};
		sheet.refresh(cx);
		let load = TreeRequest::LoadSessionTree { session: sheet.session.clone() };
		let request = sheet.send(load, cx);
		sheet.sent.push(request);
		sheet
	}

	/// The session the sheet shows.
	#[must_use]
	pub const fn session(&self) -> &SessionId {
		&self.session
	}

	/// The entry the keyboard is on.
	#[must_use]
	pub const fn selected(&self) -> Option<&EntryId> {
		self.selected.as_ref()
	}

	/// The session's tree, once the host sent it.
	fn tree<'a>(&self, cx: &'a App) -> Option<&'a SessionTreeView> {
		self.app.read(cx).store().session_tree(&self.session)
	}

	/// The node of `entry` in the session's tree.
	fn node<'a>(&self, entry: &EntryId, cx: &'a App) -> Option<&'a SessionTreeNode> {
		self.tree(cx)?.nodes.iter().find(|node| node.id == *entry)
	}

	/// The filter the rows are shown by: the one picked, else the host's.
	fn current_filter(&self, cx: &App) -> SessionTreeFilter {
		self
			.filter
			.or_else(|| self.tree(cx).map(|tree| tree.filter))
			.unwrap_or_default()
	}

	/// Where among the shown rows the keyboard is.
	fn selected_ix(&self, cx: &App) -> Option<usize> {
		let tree = self.tree(cx)?;
		let selected = self.selected.as_ref()?;
		self
			.shown
			.iter()
			.position(|ix| tree.nodes.get(*ix).is_some_and(|node| node.id == *selected))
	}

	/// The control the sheet's requests are sent from.
	fn surface(&self) -> SurfaceId {
		SurfaceId::SessionTreeSheet(self.session.clone())
	}

	/// Queues `request` from the sheet and clears the status line.
	fn send(&mut self, request: TreeRequest, cx: &mut Context<Self>) -> RequestId {
		let surface = self.surface();
		self.status = None;
		self
			.app
			.update(cx, |app, cx| app.dispatch(HostAction::Tree(request), surface, cx))
	}

	fn on_store(&mut self, event: &StoreEvent, cx: &mut Context<Self>) {
		match event {
			StoreEvent::DomainChanged(SnapshotSectionKind::SessionTree) => {
				self.refresh(cx);
				cx.notify();
			},
			StoreEvent::RequestFinished { request, ok } => self.finished(*request, *ok, cx),
			_ => {},
		}
	}

	/// The host answered `request`: a navigation it took closes the sheet,
	/// and any request of the sheet's it refused states the host's reason.
	fn finished(&mut self, request: RequestId, ok: bool, cx: &mut Context<Self>) {
		let navigated = self
			.navigating
			.take_if(|navigating| navigating.request == request)
			.is_some();
		if !navigated {
			let Some(at) = self.sent.iter().position(|sent| *sent == request) else {
				return;
			};
			self.sent.swap_remove(at);
			if ok {
				return;
			}
		}
		if ok {
			cx.emit(SheetEvent::Closed);
		} else {
			let retries = &self.app.read(cx).store().retries;
			self.status = retries
				.reason(&self.surface())
				.map(|reason| Status::Refused(SharedString::from(reason.to_owned())));
		}
		cx.notify();
	}

	/// Lists the rows the filter shows, keeping the keyboard on its row, or
	/// putting it on the leaf when that row is filtered out.
	fn refresh(&mut self, cx: &App) {
		self.shown.clear();
		let Some(tree) = self.tree(cx) else {
			return;
		};
		let filter = self.filter.unwrap_or(tree.filter);
		self.shown.extend(
			tree
				.nodes
				.iter()
				.enumerate()
				.filter(|(_, node)| node.shown_in.contains(&filter))
				.map(|(ix, _)| ix),
		);
		if self.selected_ix(cx).is_none() {
			self.selected = landing(tree, &self.shown);
			if let Some(ix) = self.selected_ix(cx) {
				self.list.scroll_to_item(ix, ScrollStrategy::Nearest);
			}
		}
	}

	/// Shows the rows `filter` shows.
	fn pick_filter(&mut self, filter: SessionTreeFilter, cx: &mut Context<Self>) {
		self.filter = Some(filter);
		self.refresh(cx);
		cx.notify();
	}
}

/// The row the keyboard lands on when its own is not shown: the leaf, else
/// the last shown row on the path to it, else the first row shown.
fn landing(tree: &SessionTreeView, shown: &[usize]) -> Option<EntryId> {
	let mut nodes = shown.iter().filter_map(|ix| tree.nodes.get(*ix));
	let leaf = nodes
		.clone()
		.find(|node| tree.leaf.as_ref() == Some(&node.id));
	leaf
		.or_else(|| nodes.clone().rfind(|node| node.on_path))
		.or_else(|| nodes.next())
		.map(|node| node.id.clone())
}

impl Focusable for SessionTreeSheet {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}
