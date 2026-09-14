//! Local review editor, thread actions and persistence seam.

mod layer;

use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_desktop_model::{
	ChangeScope,
	review::{ReviewAnchor, ReviewSide, ReviewsStore},
};
use veyyon_gpui::{AppContext, Context, Entity, FocusHandle, Pixels, Point, Subscription, Window};

use super::ShellView;
use crate::{
	palette::motion::FloatMotion,
	right_panel::review::{anchor_for_line, in_repository, unresolved},
};

pub(super) struct ReviewState {
	store:        ReviewsStore,
	open:         bool,
	repository:   Option<(String, ChangeScope)>,
	file:         Option<String>,
	draft:        Option<ReviewAnchor>,
	reply:        Option<u64>,
	editor:       Option<Entity<Editor>>,
	subscription: Option<Subscription>,
	return_focus: Option<FocusHandle>,
	focus:        Option<FocusHandle>,
	origin:       Point<Pixels>,
	motion:       FloatMotion,
	error:        Option<String>,
	reconciled:   Option<(u64, u64, (String, ChangeScope))>,
}

impl Default for ReviewState {
	fn default() -> Self {
		Self {
			store:        ReviewsStore::default(),
			open:         false,
			repository:   None,
			file:         None,
			draft:        None,
			reply:        None,
			editor:       None,
			subscription: None,
			return_focus: None,
			focus:        None,
			origin:       Point::default(),
			motion:       FloatMotion::new(veyyon_desktop_motion::SurfaceId::RightPanel, 1),
			error:        None,
			reconciled:   None,
		}
	}
}

impl ShellView {
	#[must_use]
	pub const fn review_store(&self) -> &ReviewsStore {
		&self.review.store
	}

	pub fn restore_review_store(&mut self, store: &ReviewsStore) {
		self.review.store.clone_from(store);
		self.review.reconciled = None;
	}

	/// Reconciles the completed host snapshot before drawing or persisting the
	/// window.
	pub fn reconcile_reviews(&mut self) {
		let panel = &self.state.panel;
		let Some(identity) = panel.review_repository.as_ref() else {
			return;
		};
		if !crate::right_panel::review::complete_snapshot(panel) {
			return;
		}
		if self
			.review
			.reconciled
			.as_ref()
			.is_some_and(|(session, revision, previous)| {
				*session == self.state.current_id
					&& *revision == panel.derived_from.changes
					&& previous == identity
			}) {
			return;
		}
		crate::right_panel::review::reconcile(panel, &mut self.review.store);
		self.review.reconciled =
			Some((self.state.current_id, panel.derived_from.changes, identity.clone()));
	}

	#[must_use]
	pub const fn review_is_open(&self) -> bool {
		self.review.open
	}

	/// Counts orphaned threads as requiring attention, without changing any host
	/// control.
	#[must_use]
	pub fn unresolved_reviews(&self, file: Option<&str>) -> usize {
		self
			.review
			.store
			.threads
			.iter()
			.filter(|thread| {
				in_repository(&self.state.panel, thread)
					&& file.is_none_or(|file| thread.anchor.file == file)
					&& unresolved(thread)
			})
			.count()
	}

	pub fn open_review_line(
		&mut self,
		file: &str,
		side: ReviewSide,
		line: usize,
		origin: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> bool {
		let Some(anchor) = anchor_for_line(&self.state.panel, file, side, line) else {
			return false;
		};
		if !self.has_review_draft(cx) {
			self.review.repository = Some((anchor.repository.clone(), anchor.scope));
			self.review.file = Some(file.to_owned());
			self.review.draft = Some(anchor);
			self.review.reply = None;
		}
		self.show_review(origin, window, cx);
		true
	}

	pub fn open_review_threads(
		&mut self,
		file: Option<String>,
		origin: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if self.state.panel.review_repository.is_none() {
			return;
		}
		if !self.has_review_draft(cx) {
			self
				.review
				.repository
				.clone_from(&self.state.panel.review_repository);
			self.review.file = file;
			self.review.draft = None;
			self.review.reply = None;
		}
		self.show_review(origin, window, cx);
	}

	fn has_review_draft(&self, cx: &Context<Self>) -> bool {
		self
			.review
			.editor
			.as_ref()
			.is_some_and(|editor| !editor.read(cx).text().is_empty())
	}

	fn show_review(&mut self, origin: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
		self.ensure_review_editor(cx);
		if !self.review.open {
			self.review.return_focus = window.focused(cx);
		}
		self.review.open = true;
		self.review.origin = origin;
		if (self.review.draft.is_some() || self.review.reply.is_some())
			&& let Some(editor) = &self.review.editor
		{
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		} else if let Some(focus) = &self.review.focus {
			window.focus(focus, cx);
		}
		cx.notify();
	}

	fn ensure_review_editor(&mut self, cx: &mut Context<Self>) {
		if self.review.editor.is_some() {
			return;
		}
		self.review.focus = Some(cx.focus_handle());
		let editor = cx.new(|cx| {
			Editor::new(EditorMode::Multiline { newline_on_enter: true }, cx)
				.placeholder("Write a local review comment")
				.max_visible_lines(4)
		});
		self.review.subscription =
			Some(cx.subscribe(&editor, |view, _, event: &EditorEvent, cx| match event {
				EditorEvent::Submit => view.post_review(cx),
				EditorEvent::Escape => {
					view.review.open = false;
					cx.notify();
				},
				EditorEvent::Changed | EditorEvent::PasteMedia(_) => {},
			}));
		self.review.editor = Some(editor);
	}

	pub fn close_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.review.open = false;
		if let Some(focus) = self.review.return_focus.take() {
			window.focus(&focus, cx);
		}
		cx.notify();
	}

	fn post_review(&mut self, cx: &mut Context<Self>) {
		let Some(editor) = &self.review.editor else {
			return;
		};
		let editor = editor.clone();
		let text = editor.read(cx).text();
		let success = if let Some(id) = self.review.reply {
			self.review.store.reply(id, text)
		} else if let Some(anchor) = &self.review.draft {
			if let Some(id) = self.review.store.create(anchor.clone(), text) {
				self.review.reply = Some(id);
				self.review.draft = None;
				true
			} else {
				false
			}
		} else {
			false
		};
		if success {
			editor.update(cx, |editor, cx| {
				editor.take_text(cx);
			});
			self.review.error = None;
			self.review.reconciled = None;
			self.reconcile_reviews();
		} else {
			self.review.error =
				Some("Enter a comment and select a diff line or a thread to reply to.".to_owned());
		}
		cx.notify();
	}

	fn reply_to_review(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
		if self.has_review_draft(cx) && self.review.reply != Some(id) {
			self.review.error =
				Some("Post or clear the current comment before replying to another thread.".to_owned());
		} else {
			self.review.reply = Some(id);
			self.review.draft = None;
			self.review.error = None;
			if let Some(editor) = &self.review.editor {
				let focus = editor.read(cx).focus_handle().clone();
				window.focus(&focus, cx);
			}
		}
		cx.notify();
	}
}
