//! The composer: the draft, its attachments and the controls that send it.
//!
//! The editor grows from three rows to 40% of the thread before it scrolls.
//! Above the frame sit the strips for what the session holds (a refused
//! prompt, queued prompts, the command a turn waits on, dictation, extension
//! widgets) and the inline completion list; inside it, the attachment tray,
//! the editor and the footer with the pickers, the mode and plan chips,
//! attach, dictation, history, the context meter and send or stop.
//!
//! The composer renders for the events it draws and for its own editor. A
//! streamed delta costs one hash lookup and renders nothing unless the turn
//! started or ended.

pub mod attach;
mod complete;
mod dictate;
mod draft;
mod footer;
mod history;
mod listen;
pub mod measure;
mod picker;
mod primary;
pub(crate) mod route;
mod strips;
mod submit;
mod tray;
mod view;

use gpui::{
	App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, Pixels, SharedString,
	Subscription, Window, prelude::*,
};
use veyyon_desktop_model::{QueueMode, SessionId, SnapshotSectionKind};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	theme::{size, space, text},
};

pub(crate) use self::footer::tokens;
pub use self::{
	attach::{Attachment, MAX_ATTACHMENTS, MediaType},
	listen::init,
	measure::Resized,
	primary::Primary,
};
use self::{
	complete::Completion, dictate::Landing, draft::Bridge, history::Recall, measure::Measured,
	picker::Pickers, submit::Refused,
};
use crate::{AppState, StoreEvent};

/// The key context the composer declares.
pub const KEY_CONTEXT: &str = "Composer";

/// The fewest rows the editor shows.
const MIN_ROWS: usize = 3;
/// The share of the thread's height the editor grows to before it scrolls.
const MAX_HEIGHT_SHARE: f32 = 0.4;

/// The composer region.
pub struct Composer {
	app:            Entity<AppState>,
	editor:         Entity<Editor>,
	session:        Option<SessionId>,
	attachments:    Vec<Attachment>,
	/// Paths a persisted draft names that are still being read back.
	restoring:      Vec<String>,
	/// Why the last attachment or send was refused here, until the next one.
	notice:         Option<SharedString>,
	/// The prompt in flight and the prompt the host refused.
	refused:        Refused,
	queue_mode:     QueueMode,
	/// Whether a turn runs in the session, so a delta renders nothing.
	running:        bool,
	/// Whether the draft is empty and what send does, as last drawn; a
	/// keystroke renders the composer only when one of them moves.
	shape:          (bool, Primary),
	completion:     Option<Completion>,
	recall:         Recall,
	landing:        Landing,
	pickers:        Pickers,
	/// What the composer exchanges with the host's extension bridge.
	bridge:         Bridge,
	/// Text changes the composer made itself, whose `Changed` events do not
	/// open completion or forget a recall.
	programmatic:   usize,
	/// Clipboard images pasted so far, which numbers the next one.
	pasted:         u64,
	max_rows:       usize,
	bounds:         Option<Bounds<Pixels>>,
	renders:        usize,
	_subscriptions: Vec<Subscription>,
}

impl EventEmitter<Resized> for Composer {}

impl Measured for Composer {
	fn bounds_mut(&mut self) -> &mut Option<Bounds<Pixels>> {
		&mut self.bounds
	}
}

impl Composer {
	/// The composer over `app`, showing the session the window shows.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		init(cx);
		let editor = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::MultiLine { submit_on_enter: true }, window, cx);
			editor.set_placeholder("Ask anything · @ mentions a file · / runs a command", cx);
			editor.set_line_limits(MIN_ROWS, None, cx);
			editor
		});
		let focus = editor.focus_handle(cx);
		crate::workspace::register_focus(crate::workspace::FocusSlot::Composer, &focus, cx);
		route::register(window, &cx.entity(), cx);
		let (pickers, picker_subscriptions) = Pickers::new(window, cx);
		let mut subscriptions = vec![
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| this.on_store_event(event, cx)),
			cx.subscribe(&editor, |this, _, event: &EditorEvent, cx| this.on_editor_event(*event, cx)),
			cx.observe(&editor, |this, _, cx| this.report_draft(cx)),
			cx.observe_window_bounds(window, |this, window, cx| this.fit_rows(window, cx)),
		];
		subscriptions.extend(picker_subscriptions);
		let mut composer = Self {
			app,
			editor,
			session: None,
			attachments: Vec::new(),
			restoring: Vec::new(),
			notice: None,
			refused: Refused::default(),
			queue_mode: QueueMode::default(),
			running: false,
			shape: (true, Primary::Send),
			completion: None,
			recall: Recall::default(),
			landing: Landing::default(),
			pickers,
			bridge: Bridge::default(),
			programmatic: 0,
			pasted: 0,
			max_rows: 0,
			bounds: None,
			renders: 0,
			_subscriptions: subscriptions,
		};
		composer.fit_rows(window, cx);
		let session = composer.app.read(cx).active_session().cloned();
		composer.show_session(session, cx);
		composer
	}

	/// The editor holding the draft.
	pub const fn editor(&self) -> &Entity<Editor> {
		&self.editor
	}

	/// The draft.
	pub fn text<'a>(&self, cx: &'a App) -> &'a str {
		self.editor.read(cx).text()
	}

	/// The session the composer writes to.
	pub const fn session(&self) -> Option<&SessionId> {
		self.session.as_ref()
	}

	/// The files waiting to be sent with the next prompt.
	pub fn attachments(&self) -> &[Attachment] {
		&self.attachments
	}

	/// Why the last attachment or send was refused here.
	pub fn notice(&self) -> Option<&str> {
		self.notice.as_deref()
	}

	/// Whether a prompt sent during a turn steers it or queues behind it.
	pub const fn queue_mode(&self) -> QueueMode {
		self.queue_mode
	}

	/// What the primary control does now.
	pub const fn primary_action(&self) -> Primary {
		self.shape.1
	}

	/// The height the composer last laid out at, or before its first layout
	/// the height of an empty draft with no strips, so a parent laying it out
	/// cached draws the first frame at the size it settles to.
	pub fn height(&self) -> Pixels {
		self
			.bounds
			.map_or_else(Self::min_height, |bounds| bounds.size.height)
	}

	/// The height of the composer with an empty draft and nothing above or
	/// below its frame: the editor's fewest rows, the footer's controls, the
	/// frame's padding and hairline border, and the region's bottom inset.
	pub fn min_height() -> Pixels {
		let editor = text::BODY.line_height * MIN_ROWS as f32;
		let frame = space::S3 + editor + space::S2 + size::CONTROL + space::S2 + size::HAIRLINE * 2.0;
		frame + space::S4
	}

	/// How many times the composer has rendered.
	pub const fn render_count(&self) -> usize {
		self.renders
	}

	/// Sizes the editor to grow to [`MAX_HEIGHT_SHARE`] of the thread.
	fn fit_rows(&mut self, window: &Window, cx: &mut Context<Self>) {
		let thread = window.viewport_size().height - size::HEADER;
		let share = thread * MAX_HEIGHT_SHARE;
		let rows = ((share / text::BODY.line_height).floor() as usize).max(MIN_ROWS);
		if rows != self.max_rows {
			self.max_rows = rows;
			self
				.editor
				.update(cx, |editor, cx| editor.set_line_limits(MIN_ROWS, Some(rows), cx));
		}
	}

	fn on_store_event(&mut self, event: &StoreEvent, cx: &mut Context<Self>) {
		match event {
			StoreEvent::ActiveSessionChanged => {
				let session = self.app.read(cx).active_session().cloned();
				if session != self.session {
					self.show_session(session, cx);
				}
			},
			StoreEvent::StreamingChanged { session } if self.session.as_ref() == Some(session) => {
				let running = self.app.read(cx).is_turn_running(session);
				if running != self.running {
					self.running = running;
					self.reshape(cx);
					cx.notify();
				}
			},
			StoreEvent::InteractionsChanged { session } if self.session.as_ref() == Some(session) => {
				self.reshape(cx);
			},
			StoreEvent::RequestFinished { request, ok } => {
				self.request_finished(*request, *ok, cx);
				// A settled branch hands back the prompt it cut off.
				if *ok {
					self.take_restored(cx);
				}
			},
			StoreEvent::DomainChanged(kind) => self.on_domain(*kind, cx),
			StoreEvent::ConnectionChanged => cx.notify(),
			_ => {},
		}
	}

	fn on_domain(&mut self, kind: SnapshotSectionKind, cx: &mut Context<Self>) {
		match kind {
			SnapshotSectionKind::QueuedPrompts => {
				self.take_restored(cx);
				cx.notify();
			},
			SnapshotSectionKind::PromptHistory => self.history_arrived(cx),
			SnapshotSectionKind::Commands
			| SnapshotSectionKind::SearchResults
			| SnapshotSectionKind::ComposerCompletions
				if self.completion.is_some() =>
			{
				self.clamp_highlight(cx);
				cx.notify();
			},
			SnapshotSectionKind::ComposerEdit => {
				self.apply_edits(cx);
				self.report_draft(cx);
			},
			SnapshotSectionKind::Dictation => self.dictation_changed(cx),
			SnapshotSectionKind::Models => {
				self.models_changed(cx);
				cx.notify();
			},
			SnapshotSectionKind::Capabilities => {
				let mode = self.app.read(cx).effective_queue_mode(self.queue_mode);
				self.queue_mode = mode;
				self.reshape(cx);
				cx.notify();
			},
			SnapshotSectionKind::ActiveSession
			| SnapshotSectionKind::ForegroundCommand
			| SnapshotSectionKind::Goal
			| SnapshotSectionKind::Todo
			| SnapshotSectionKind::ContextBreakdown
			| SnapshotSectionKind::ServingAccount
			| SnapshotSectionKind::ExtensionUi => cx.notify(),
			_ => {},
		}
	}

	fn on_editor_event(&mut self, event: EditorEvent, cx: &mut Context<Self>) {
		match event {
			EditorEvent::Changed => self.text_changed(cx),
			EditorEvent::Submit => self.submit(cx),
			EditorEvent::HistoryPrev => self.recall_prev(cx),
			EditorEvent::HistoryNext => self.recall_next(cx),
			EditorEvent::Escape => {
				self.close_completion(cx);
			},
			EditorEvent::Focused | EditorEvent::Blurred => cx.notify(),
		}
	}

	/// Replaces the draft with `text` without opening completion.
	fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
		if self.text(cx) == text {
			return;
		}
		self.programmatic += 1;
		self
			.editor
			.update(cx, |editor, cx| editor.set_text(text, cx));
	}

	fn text_changed(&mut self, cx: &mut Context<Self>) {
		let programmatic = self.programmatic > 0;
		self.programmatic = self.programmatic.saturating_sub(1);
		self.save_draft(cx);
		self.reshape(cx);
		if programmatic {
			return;
		}
		self.recall.forget();
		self.update_completion(cx);
	}

	/// Renders the composer when the draft turned empty or non-empty or send
	/// changed what it does.
	fn reshape(&mut self, cx: &mut Context<Self>) {
		let shape = (self.text(cx).trim().is_empty(), self.primary(cx));
		if shape != self.shape {
			self.shape = shape;
			cx.notify();
		}
	}

	/// Replaces the draft with `text`, the caret at its end, and focuses it.
	fn insert_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
		self.set_text(text, cx);
		self
			.editor
			.update(cx, |editor, cx| editor.focus(window, cx));
	}
}

impl Focusable for Composer {
	fn focus_handle(&self, cx: &App) -> FocusHandle {
		self.editor.focus_handle(cx)
	}
}
