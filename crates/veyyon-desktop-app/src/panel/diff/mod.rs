//! The diff tab: the host's working tree or staged changes, per file,
//! collapsible, unified or side by side, with window-local review threads.
//!
//! The diff is parsed once per host answer and laid out into rows once per
//! layout change; the list draws only the rows in view. Each file side is
//! highlighted, and each file's paired lines aligned word by word, on the
//! background executor the first time one of its rows is drawn, and drawn
//! plain until the spans arrive.

pub mod parse;
mod review;
pub mod rows;
mod threads;
mod toolbar;
mod view;
mod words;

use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use veyyon_desktop_model::{
	ChangeScope, HostAction, SnapshotSectionKind, SurfaceId, review::ReviewAnchor,
};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	markdown::{Highlighted, highlight},
};
use veyyon_gpui::{Context, Entity, ListAlignment, ListState, Subscription, Window, prelude::*};

use self::{
	parse::{ParsedDiff, Side},
	review::ReviewScope,
	rows::{Layout, Placements},
	words::Emphasis,
};
use super::style::language_tag;
use crate::{AppState, StoreEvent};

/// What a comment being written will become.
#[derive(Clone, Debug)]
enum DraftTarget {
	/// A new thread on this anchor.
	New(ReviewAnchor),
	/// A reply to this thread.
	Reply(u64),
}

/// The comment being written, under the row it belongs to.
struct Draft {
	file:          usize,
	line:          usize,
	target:        DraftTarget,
	editor:        Entity<Editor>,
	_subscription: Subscription,
}

/// The diff tab's view.
pub struct DiffView {
	app:            Entity<AppState>,
	parsed:         Arc<ParsedDiff>,
	answers:        u64,
	scope:          Option<ReviewScope>,
	change_scope:   ChangeScope,
	layout:         Layout,
	placements:     Placements,
	collapsed:      HashSet<String>,
	highlights:     HashMap<(usize, Side), Arc<Highlighted>>,
	pending:        HashSet<(usize, Side)>,
	/// Each file's changed words, `None` while they are being aligned.
	words:          HashMap<usize, Option<Arc<Emphasis>>>,
	list:           ListState,
	/// Whether a line longer than the pane wraps; clipped at its edge when not.
	wrap:           bool,
	draft:          Option<Draft>,
	renders:        u64,
	_subscriptions: Vec<Subscription>,
}

impl DiffView {
	/// Builds the tab over `app`'s changes.
	pub fn new(app: Entity<AppState>, _: &mut Window, cx: &mut Context<Self>) -> Self {
		let subscription = cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
			StoreEvent::DomainChanged(SnapshotSectionKind::Changes) => this.reparse(cx),
			StoreEvent::DomainChanged(SnapshotSectionKind::Capabilities) => cx.notify(),
			StoreEvent::ActiveSessionChanged => this.relayout(cx),
			_ => {},
		});
		let mut view = Self {
			app,
			parsed: Arc::default(),
			answers: 0,
			scope: None,
			change_scope: ChangeScope::WorkingTree,
			layout: Layout::default(),
			placements: Placements::default(),
			collapsed: HashSet::new(),
			highlights: HashMap::new(),
			pending: HashSet::new(),
			words: HashMap::new(),
			list: ListState::new(
				0,
				ListAlignment::Top,
				veyyon_desktop_ui::theme::size::TOOL_OUTPUT_MAX,
			),
			wrap: true,
			draft: None,
			renders: 0,
			_subscriptions: vec![subscription],
		};
		view.reparse(cx);
		view
	}

	/// The parsed diff the tab draws.
	pub fn parsed(&self) -> &ParsedDiff {
		&self.parsed
	}

	/// The rows the list draws.
	pub const fn layout(&self) -> &Layout {
		&self.layout
	}

	/// How many times the tab has rendered.
	pub const fn render_count(&self) -> u64 {
		self.renders
	}

	/// Parses the host's changes again when a new answer arrived, and
	/// orphans the review threads a complete diff lost.
	fn reparse(&mut self, cx: &mut Context<Self>) {
		let (answers, parsed, scope) = {
			let changes = &self.app.read(cx).store().domains.changes;
			if changes.answers() == self.answers && self.answers > 0 {
				return;
			}
			let view = changes.get();
			(
				changes.answers(),
				view.map(parse::parse).unwrap_or_default(),
				view.map(|view| (view.repository.clone(), view.scope)),
			)
		};
		self.answers = answers;
		self.parsed = Arc::new(parsed);
		if let Some((_, change_scope)) = scope {
			self.change_scope = change_scope;
		}
		self.scope = scope.and_then(|(repository, scope)| {
			repository.map(|repository| ReviewScope { repository, scope })
		});
		self.highlights.clear();
		self.pending.clear();
		self.words.clear();
		self.draft = None;
		if let Some(scope) = self.scope.clone() {
			let parsed = Arc::clone(&self.parsed);
			self
				.app
				.update(cx, |app, _| review::reconcile(&parsed, app.reviews_mut(), &scope));
		}
		self.relayout(cx);
	}

	/// Lays the rows out again after the layout, a collapse, a thread or the
	/// draft changed.
	pub fn relayout(&mut self, cx: &mut Context<Self>) {
		let app = self.app.read(cx);
		self.placements = self
			.scope
			.as_ref()
			.map(|scope| review::place(&self.parsed, app.reviews(), scope))
			.unwrap_or_default();
		let draft = self.draft.as_ref().map(|draft| (draft.file, draft.line));
		self.layout =
			rows::layout(&self.parsed, app.diff_mode(), &self.collapsed, &self.placements, draft);
		self.list.reset(self.layout.rows.len());
		cx.notify();
	}

	/// Collapses `path` to its header, or expands it.
	pub fn toggle_file(&mut self, path: &str, cx: &mut Context<Self>) {
		if !self.collapsed.remove(path) {
			self.collapsed.insert(path.to_owned());
		}
		self.relayout(cx);
	}

	/// Collapses every file when any is expanded, and expands every file
	/// otherwise.
	pub fn toggle_all(&mut self, cx: &mut Context<Self>) {
		if self.collapsed.len() < self.parsed.files.len() {
			self.collapsed = self
				.parsed
				.files
				.iter()
				.map(|file| file.path.clone())
				.collect();
		} else {
			self.collapsed.clear();
		}
		self.relayout(cx);
	}

	/// Whether every file is collapsed.
	fn all_collapsed(&self) -> bool {
		!self.parsed.files.is_empty() && self.collapsed.len() >= self.parsed.files.len()
	}

	/// Asks the host for the changes of `scope`.
	fn select_scope(&mut self, scope: ChangeScope, cx: &mut Context<Self>) {
		self.change_scope = scope;
		self.send(HostAction::SelectChangeScope { scope }, cx);
		cx.notify();
	}

	/// Asks the host for the changes again.
	fn refresh(&self, cx: &mut Context<Self>) {
		self.send(HostAction::RefreshChanges, cx);
	}

	fn send(&self, action: HostAction, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| {
			let surface = app
				.active_session()
				.cloned()
				.map_or(SurfaceId::GlobalTitlebarLine, SurfaceId::RightPanelChangeScopeSelector);
			app.dispatch(action, surface, cx);
		});
	}

	/// Highlights `side` of file `file` on the background executor unless
	/// its spans are held or on their way.
	fn ensure_highlight(&mut self, file: usize, side: Side, cx: &Context<Self>) {
		let key = (file, side);
		if self.highlights.contains_key(&key) || !self.pending.insert(key) {
			return;
		}
		let Some(diff_file) = self.parsed.files.get(file) else {
			return;
		};
		let text = diff_file.side_text(&self.parsed.source, side);
		let lang = language_tag(&diff_file.path).to_owned();
		let answers = self.answers;
		let task = cx.background_spawn(async move { highlight(&text, Some(&lang)) });
		cx.spawn(async move |this, cx| {
			let highlighted = task.await;
			this
				.update(cx, |this, cx| {
					if this.answers == answers {
						this.pending.remove(&key);
						this.highlights.insert(key, highlighted);
						cx.notify();
					}
				})
				.ok();
		})
		.detach();
	}

	/// Aligns the paired lines of file `file` on the background executor
	/// unless their words are held or on their way.
	fn ensure_words(&mut self, file: usize, cx: &Context<Self>) {
		if self.words.contains_key(&file) {
			return;
		}
		self.words.insert(file, None);
		let parsed = Arc::clone(&self.parsed);
		let answers = self.answers;
		let task = cx.background_spawn(async move {
			parsed
				.files
				.get(file)
				.map(|diff_file| Emphasis::of(&parsed.source, diff_file))
				.unwrap_or_default()
		});
		cx.spawn(async move |this, cx| {
			let emphasis = Arc::new(task.await);
			this
				.update(cx, |this, cx| {
					if this.answers == answers {
						this.words.insert(file, Some(emphasis));
						cx.notify();
					}
				})
				.ok();
		})
		.detach();
	}

	/// Opens a comment under line `line` of file `file`, as a new thread or
	/// as a reply to `thread`.
	fn start_draft(
		&mut self,
		file: usize,
		line: usize,
		thread: Option<u64>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let target = if let Some(thread) = thread {
			DraftTarget::Reply(thread)
		} else {
			let Some(anchor) = self
				.scope
				.as_ref()
				.and_then(|scope| review::anchor(&self.parsed, scope, file, line))
			else {
				return;
			};
			DraftTarget::New(anchor)
		};
		let editor = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::MultiLine { submit_on_enter: true }, window, cx);
			editor.set_placeholder("Leave a comment", cx);
			editor.set_line_limits(2, Some(8), cx);
			editor
		});
		editor.update(cx, |editor, cx| editor.focus(window, cx));
		let subscription = cx.subscribe(&editor, |this, _, event: &EditorEvent, cx| match event {
			EditorEvent::Submit => this.submit_draft(cx),
			EditorEvent::Escape => this.cancel_draft(cx),
			_ => {},
		});
		self.draft = Some(Draft { file, line, target, editor, _subscription: subscription });
		self.relayout(cx);
	}

	/// Saves the comment being written; an empty one saves nothing.
	fn submit_draft(&mut self, cx: &mut Context<Self>) {
		let Some(draft) = self.draft.take() else {
			return;
		};
		let text = draft.editor.read(cx).text().to_owned();
		self.app.update(cx, |app, _| match draft.target {
			DraftTarget::New(anchor) => {
				app.reviews_mut().create(anchor, &text);
			},
			DraftTarget::Reply(thread) => {
				app.reviews_mut().reply(thread, &text);
			},
		});
		self.relayout(cx);
	}

	fn cancel_draft(&mut self, cx: &mut Context<Self>) {
		if self.draft.take().is_some() {
			self.relayout(cx);
		}
	}

	fn set_resolved(&mut self, thread: u64, resolved: bool, cx: &mut Context<Self>) {
		self
			.app
			.update(cx, |app, _| app.reviews_mut().set_resolved(thread, resolved));
		self.relayout(cx);
	}
}
