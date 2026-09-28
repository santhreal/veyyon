//! The draft each session keeps, and the edits an extension makes to it.
//!
//! Every change to the draft is recorded in the store's persisted composer
//! state for the session, with the paths of the attached files and the queue
//! mode, so switching threads and reopening the window both find the draft
//! where it was left. Files a persisted draft names are read again off the
//! window's thread. The host holds a copy of the draft for extensions that
//! read it, and queues the edits they make until the session is shown here.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use gpui::{AppContext as _, Context};
use veyyon_desktop_model::{
	ComposerEditKind, ComposerRequest, ComposerStore, Gate, HostAction, HostActionKind, SessionId,
	SurfaceId,
};

use super::{
	Composer,
	attach::{self, Source},
	dictate::Landing,
};

/// What the composer exchanges with the host's extension bridge for each
/// session.
#[derive(Default)]
pub(super) struct Bridge {
	/// The number of the last extension edit applied to each session's draft.
	applied:           HashMap<SessionId, u64>,
	/// The number of the last completion request sent.
	pub(super) query:  u64,
	/// Whether the host was asked for its commands, which it lists once.
	pub(super) listed: bool,
	/// The draft revision and caret last reported, so a caret that did not
	/// move reports nothing.
	reported:          Option<(u64, usize)>,
}

impl Composer {
	/// Shows `session`'s draft, queue mode and attachments.
	pub(super) fn show_session(&mut self, session: Option<SessionId>, cx: &mut Context<Self>) {
		self.session.clone_from(&session);
		self.forget_sent();
		self.recall.forget();
		self.completion = None;
		self.notice = None;
		self.attachments.clear();
		self.restoring.clear();
		self.landing = Landing::default();
		self.bridge.reported = None;
		let (text, paths, mode, running) = {
			let app = self.app.read(cx);
			let draft = session.as_ref().and_then(|session| app.draft(session));
			(
				draft
					.map(|draft| draft.draft_text.clone())
					.unwrap_or_default(),
				draft
					.map(|draft| draft.attachments.clone())
					.unwrap_or_default(),
				app.effective_queue_mode(draft.map(|draft| draft.queue_mode).unwrap_or_default()),
				session
					.as_ref()
					.is_some_and(|session| app.is_turn_running(session)),
			)
		};
		self.queue_mode = mode;
		self.running = running;
		self.set_text(&text, cx);
		self.restoring.clone_from(&paths);
		self.attach_paths(paths.into_iter().map(PathBuf::from).collect(), true, cx);
		self.take_restored(cx);
		self.apply_edits(cx);
		self.report_draft(cx);
		self.reshape(cx);
		cx.notify();
	}

	/// Records the draft in the store's persisted composer state.
	pub(super) fn save_draft(&self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let attachments = self
			.attachments
			.iter()
			.filter_map(|attachment| match &attachment.source {
				Source::Path(path) => Some(path.display().to_string()),
				Source::Clipboard(_) => None,
			})
			.chain(self.restoring.iter().cloned())
			.collect();
		let draft = ComposerStore {
			draft_text: self.text(cx).to_owned(),
			attachments,
			queue_mode: self.queue_mode,
			..ComposerStore::default()
		};
		self.app.update(cx, |app, _| app.save_draft(session, draft));
	}

	/// Puts the prompt a take-back handed back before the draft.
	pub(super) fn take_restored(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let Some(restored) = self
			.app
			.update(cx, |app, _| app.take_restored_prompt(&session))
		else {
			return;
		};
		let draft = self.text(cx).trim();
		let text = if draft.is_empty() {
			restored
		} else {
			format!("{restored}\n\n{draft}")
		};
		self.set_text(&text, cx);
	}

	/// Applies the edits extensions made to the shown session's draft.
	pub(super) fn apply_edits(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let edits = self
			.app
			.update(cx, |app, _| app.take_composer_edits(&session));
		for edit in edits {
			match edit.kind {
				ComposerEditKind::Set => self.set_text(&edit.text, cx),
				ComposerEditKind::Paste => {
					self.programmatic += 1;
					self.editor.update(cx, |editor, cx| {
						let range = editor.buffer().selection().range();
						editor.replace_range(range, &edit.text, cx);
					});
				},
			}
			self.bridge.applied.insert(session.clone(), edit.seq);
		}
	}

	/// Sends the host the draft and the caret, for extensions that read it,
	/// when either moved since the last report.
	pub(super) fn report_draft(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let app = self.app.read(cx);
		if matches!(app.gate(HostActionKind::ReportComposerDraft), Gate::Unavailable { .. }) {
			return;
		}
		let editor = self.editor.read(cx);
		let at = (editor.buffer().revision(), editor.cursor_offset());
		if self.bridge.reported == Some(at) {
			return;
		}
		self.bridge.reported = Some(at);
		let action = HostAction::Composer(ComposerRequest::ReportComposerDraft {
			session:      session.clone(),
			text:         editor.text().to_owned(),
			cursor:       u32::try_from(editor.cursor_offset()).unwrap_or(u32::MAX),
			applied_edit: self.bridge.applied.get(&session).copied().unwrap_or(0),
		});
		self.app.update(cx, |app, cx| {
			app.dispatch(action, SurfaceId::ComposerDraftReport(session), cx);
		});
	}

	/// Reads the files at `paths` off the window's thread and attaches the
	/// ones that fit; `restoring` marks paths a persisted draft named.
	pub(super) fn attach_paths(&self, paths: Vec<PathBuf>, restoring: bool, cx: &Context<Self>) {
		if paths.is_empty() {
			return;
		}
		let session = self.session.clone();
		cx.spawn(async move |this, cx| {
			let read = cx
				.background_spawn(async move {
					paths
						.iter()
						.map(|path| attach::read_file(Path::new(path)))
						.collect::<Vec<_>>()
				})
				.await;
			let _ = this.update(cx, |this, cx| {
				if this.session != session {
					return;
				}
				if restoring {
					this.restoring.clear();
				}
				this.admit_all(read, cx);
			});
		})
		.detach();
	}

	/// Adds each read file that fits beside the tray, stating why the first
	/// that did not was left out.
	fn admit_all(
		&mut self,
		read: Vec<Result<attach::Attachment, attach::AttachError>>,
		cx: &mut Context<Self>,
	) {
		let mut refusal = None;
		for result in read {
			let admitted = result.and_then(|attachment| {
				attach::admit(&self.attachments, &attachment).map(|()| attachment)
			});
			match admitted {
				Ok(attachment) => self.attachments.push(attachment),
				Err(error) => {
					refusal.get_or_insert_with(|| error.to_string());
				},
			}
		}
		self.notice = refusal.map(Into::into);
		self.save_draft(cx);
		self.reshape(cx);
		cx.notify();
	}

	/// Admits one attachment made on the window's thread.
	pub(super) fn admit_one(
		&mut self,
		made: Result<attach::Attachment, attach::AttachError>,
		cx: &mut Context<Self>,
	) {
		self.admit_all(vec![made], cx);
	}
}
