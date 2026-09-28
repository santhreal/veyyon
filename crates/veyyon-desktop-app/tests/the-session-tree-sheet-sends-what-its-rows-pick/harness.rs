//! A window whose root is the real session tree sheet over a store fed host
//! events, the trees the suites feed it and the requests they expect back.

use std::{cell::Cell, rc::Rc, time::Duration};

use gpui::{
	AppContext as _, Entity, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, TestAppContext,
	VisualTestContext, px, size,
};
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{
	AppState, driver, keymap,
	thread::tree::{SessionTreeSheet, SheetEvent},
};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, EntryId, ErrorScope, HostAction, HostEvent,
	HostRequest, RequestId, SessionId, SessionTreeEntryKind as Kind, SessionTreeFilter as Filter,
	SessionTreeNode, SessionTreeView, SnapshotSection, Store, TreeRequest,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The session every suite opens the sheet on.
pub const SESSION: &str = "s";

/// One frame at 60 Hz.
const FRAME: Duration = Duration::from_millis(16);

pub struct Win<'a> {
	pub state:  Entity<AppState>,
	pub sheet:  Entity<SessionTreeSheet>,
	/// How many times the sheet reported it closed.
	pub closed: Rc<Cell<usize>>,
	pub cx:     &'a mut VisualTestContext,
}

/// Opens the sheet on `SESSION` over a store fed `events`, keeping the
/// requests the sheet queued as it opened.
pub fn window(app: &mut TestAppContext, events: Vec<HostEvent>) -> Win<'_> {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(true);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let (sheet, cx) = app.add_window_view(|window, cx| {
		SessionTreeSheet::new(view_state, SessionId::from(SESSION), window, cx)
	});
	cx.simulate_resize(size(px(900.0), px(600.0)));
	cx.run_until_parked();
	let closed = Rc::new(Cell::new(0));
	let count = closed.clone();
	cx.update(|_, cx| {
		cx.subscribe(&sheet, move |_, _: &SheetEvent, _| count.set(count.get() + 1))
			.detach();
	});
	Win { state, sheet, closed, cx }
}

/// The sheet open over `tree`, which the host sent in answer to the sheet's
/// request, every request since drained.
pub fn browsing(app: &mut TestAppContext, tree: SessionTreeView) -> Win<'_> {
	let mut w = window(app, vec![capabilities()]);
	let load = w.one();
	assert_eq!(load.action, load_tree(), "the sheet asks for its session's tree");
	w.apply(vec![tree_of(SESSION, tree), succeeded(load.id)]);
	w
}

impl Win<'_> {
	/// Every request queued since the last drain.
	pub fn requests(&mut self) -> Vec<HostRequest> {
		self.state.update(self.cx, |state, _| state.drain_outbox())
	}

	/// The actions of every request queued since the last drain.
	pub fn sent(&mut self) -> Vec<HostAction> {
		self
			.requests()
			.into_iter()
			.map(|request| request.action)
			.collect()
	}

	/// The one request queued since the last drain.
	pub fn one(&mut self) -> HostRequest {
		let mut requests = self.requests();
		assert_eq!(requests.len(), 1, "one request is queued: {requests:?}");
		requests.remove(0)
	}

	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	/// Types `text` into the field that has the keyboard.
	pub fn write(&mut self, text: &str) {
		self.cx.simulate_input(text);
		self.cx.run_until_parked();
	}

	/// The text the last frame drew.
	pub fn texts(&mut self) -> Vec<String> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| run.text.to_string())
				.collect()
		})
	}

	pub fn draws(&mut self, text: &str) -> bool {
		self.texts().iter().any(|drawn| drawn.contains(text))
	}

	/// Clicks the first drawn run that reads `text` in full, `clicks` times
	/// in a row.
	pub fn click_text(&mut self, text: &str, clicks: usize) {
		let at = self
			.cx
			.update(|window, _| {
				window
					.rendered_text_runs()
					.iter()
					.find(|run| run.text.trim() == text)
					.map(|run| run.bounds.center())
			})
			.unwrap_or_else(|| panic!("{text:?} is drawn"));
		for click_count in 1..=clicks {
			self.cx.simulate_event(MouseDownEvent {
				button: MouseButton::Left,
				position: at,
				modifiers: Modifiers::default(),
				click_count,
				first_mouse: false,
			});
			self.cx.simulate_event(MouseUpEvent {
				button: MouseButton::Left,
				position: at,
				modifiers: Modifiers::default(),
				click_count,
			});
		}
		self.cx.run_until_parked();
	}

	/// Clicks the driver target `id`.
	pub fn click(&mut self, id: &str) {
		let at = self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
			.unwrap_or_else(|| panic!("{id} is laid out"))
			.center();
		self.cx.simulate_click(at, Modifiers::none());
		self.cx.run_until_parked();
	}

	/// The entry the keyboard is on.
	pub fn selected(&self) -> Option<String> {
		self
			.sheet
			.read_with(&*self.cx, |sheet, _| sheet.selected().map(|entry| entry.0.clone()))
	}

	pub fn closed(&self) -> usize {
		self.closed.get()
	}

	/// Moves the clock a frame on and delivers the frame the window asked
	/// for. Answers whether anything asked for one.
	pub fn frame(&mut self) -> bool {
		self.cx.executor().advance_clock(FRAME);
		let asked = self.cx.update(|window, cx| window.simulate_next_frame(cx));
		self.cx.run_until_parked();
		asked > 0
	}

	/// Delivers frames until the window asks for none, failing past `bound`.
	/// Answers how long it moved.
	pub fn settle(&mut self, bound: Duration) -> Duration {
		let mut ran = Duration::ZERO;
		while self.frame() {
			ran += FRAME;
			assert!(ran <= bound, "the sheet still moves {ran:?} in");
		}
		ran
	}

	/// The texts of `tree`'s rows the last frame drew.
	pub fn drawn_rows<'t>(&mut self, tree: &'t SessionTreeView) -> Vec<&'t str> {
		let texts = self.texts();
		tree
			.nodes
			.iter()
			.map(|node| node.text.as_str())
			.filter(|row| texts.iter().any(|drawn| drawn.trim() == *row))
			.collect()
	}
}

/// The texts of `tree`'s rows `filter` shows, by the host's word.
pub fn rows_in(tree: &SessionTreeView, filter: Filter) -> Vec<&str> {
	tree
		.nodes
		.iter()
		.filter(|node| node.shown_in.contains(&filter))
		.map(|node| node.text.as_str())
		.collect()
}

/// A node `id` on the path to the leaf reading `text`, shown in `shown_in`;
/// an operator message leads with its role marker.
pub fn node(id: &str, kind: Kind, text: &str, shown_in: &[Filter]) -> SessionTreeNode {
	SessionTreeNode {
		id: EntryId::from(id),
		parent: None,
		depth: 0,
		kind,
		prefix: if kind == Kind::User {
			"user: ".to_owned()
		} else {
			String::new()
		},
		text: text.to_owned(),
		label: None,
		on_path: true,
		shown_in: shown_in.to_vec(),
	}
}

/// A session that branched: the path u1 a1 t1 m1 u2 a2 to the leaf a2, and
/// the branch b1 b2 left at a1. Each node lists the filters that show it as
/// the terminal's rules would; b1 alone holds a label, `stale-idea`.
pub fn branched(summary_offered: bool) -> SessionTreeView {
	let every: Vec<Filter> = Filter::iter().collect();
	let spoken = [Filter::Default, Filter::NoTools, Filter::All];
	let asked = [Filter::Default, Filter::NoTools, Filter::UserOnly, Filter::All];
	let mut nodes = vec![
		node("u1", Kind::User, "plan the parser", &asked),
		node("a1", Kind::Assistant, "reading the grammar", &spoken),
		node("t1", Kind::ToolResult, "[read: grammar.txt]", &[Filter::Default, Filter::All]),
		node("m1", Kind::ModelChange, "model: opus", &[Filter::All]),
		node("u2", Kind::User, "try the other branch", &asked),
		node("a2", Kind::Assistant, "parser done", &spoken),
		node("b1", Kind::User, "abandoned idea", &every),
		node("b2", Kind::Assistant, "abandoned reply", &spoken),
	];
	for (ix, branch) in nodes.iter_mut().enumerate().skip(6) {
		branch.on_path = false;
		branch.depth = 1;
		branch.parent = Some(EntryId::from(if ix == 6 { "a1" } else { "b1" }));
	}
	nodes[6].label = Some("stale-idea".to_owned());
	SessionTreeView {
		leaf: Some(EntryId::from("a2")),
		nodes,
		summary_offered,
		filter: Filter::Default,
	}
}

/// `rows` operator messages in one chain, `r0` to the leaf, each shown in
/// every filter.
pub fn long(rows: usize) -> SessionTreeView {
	let every: Vec<Filter> = Filter::iter().collect();
	let nodes: Vec<SessionTreeNode> = (0..rows)
		.map(|ix| node(&format!("r{ix}"), Kind::User, &format!("row {ix:02}"), &every))
		.collect();
	SessionTreeView {
		leaf: nodes.last().map(|node| node.id.clone()),
		nodes,
		summary_offered: false,
		filter: Filter::Default,
	}
}

/// The host answering `session`'s tree.
pub fn tree_of(session: &str, tree: SessionTreeView) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::SessionTree { session: SessionId::from(session), tree })
}

/// A host that navigates session trees.
pub fn capabilities() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::SessionTreeNavigation,
		CapabilityStatus::Available,
	)]))
}

pub const fn succeeded(request: RequestId) -> HostEvent {
	HostEvent::RequestSucceeded { request }
}

/// The host's refusal of `request`, stated as `message`.
pub fn refused(request: RequestId, message: &str) -> HostEvent {
	HostEvent::RequestFailed {
		request,
		error: BackendError {
			scope:          ErrorScope::Session,
			code:           Some("refused".to_owned()),
			message:        message.to_owned(),
			retryable:      true,
			request:        Some(request),
			occurred_at_ms: 1,
		},
	}
}

const fn tree(request: TreeRequest) -> HostAction {
	HostAction::Tree(request)
}

pub fn load_tree() -> HostAction {
	tree(TreeRequest::LoadSessionTree { session: SessionId::from(SESSION) })
}

pub fn navigate(entry: &str, summarize: bool, instructions: Option<&str>) -> HostAction {
	tree(TreeRequest::NavigateTree {
		session: SessionId::from(SESSION),
		entry: EntryId::from(entry),
		summarize,
		instructions: instructions.map(str::to_owned),
	})
}

pub fn abort() -> HostAction {
	tree(TreeRequest::AbortBranchSummary { session: SessionId::from(SESSION) })
}

pub fn label(entry: &str, label: Option<&str>) -> HostAction {
	tree(TreeRequest::SetEntryLabel {
		session: SessionId::from(SESSION),
		entry:   EntryId::from(entry),
		label:   label.map(str::to_owned),
	})
}
