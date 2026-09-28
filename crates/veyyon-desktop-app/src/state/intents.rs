//! Intents: the requests the window queues for the host.

use veyyon_desktop_model::{
	AttachmentSubmission, HostAction, HostRequest, RequestId, SessionId, SurfaceId,
};
use veyyon_gpui::Context;

use super::{
	AppState, StoreEvent,
	deadline::{REQUEST_TIMEOUT_MS, clock_ms},
	reduce::Batch,
};

impl AppState {
	/// Queues `action` on behalf of the control `surface`: registers the
	/// request in flight against `surface` with its deadline, records it as
	/// what that control's retry sends again, appends it to the outbox and
	/// emits [`StoreEvent::OutboxReady`]. A `BranchSession` is sent naming
	/// the prompt it forks at, whichever control sent it.
	pub fn dispatch(
		&mut self,
		mut action: HostAction,
		surface: SurfaceId,
		cx: &mut Context<Self>,
	) -> RequestId {
		self.next_request += 1;
		let request = RequestId(self.next_request);
		self.name_fork_point(&mut action, request);
		self.store
			.retries
			.record(request, surface.clone(), action.clone());
		let now_ms = clock_ms(&mut self.clock_epoch, cx);
		let pruned =
			self.registry
				.register(request, action.kind(), surface, now_ms, REQUEST_TIMEOUT_MS);
		self.outbox.push(HostRequest { id: request, action });
		cx.emit(StoreEvent::OutboxReady);
		self.fail_pruned(pruned, now_ms, cx);
		self.arm_deadline(cx);
		request
	}

	/// Takes every queued request, oldest first, for the transport to send.
	pub fn drain_outbox(&mut self) -> Vec<HostRequest> {
		std::mem::take(&mut self.outbox)
	}

	/// Sends a prompt to `session` from the composer.
	pub fn submit_prompt(
		&mut self,
		session: SessionId,
		text: String,
		attachments: Vec<AttachmentSubmission>,
		cx: &mut Context<Self>,
	) -> RequestId {
		let surface = SurfaceId::ComposerSendButton(session.clone());
		self.dispatch(HostAction::SubmitPrompt { session, text, attachments }, surface, cx)
	}

	/// Stops the turn running in `session`.
	pub fn abort_turn(&mut self, session: SessionId, cx: &mut Context<Self>) -> RequestId {
		let surface = SurfaceId::ComposerAbortButton(session.clone());
		self.dispatch(HostAction::AbortTurn { session }, surface, cx)
	}

	/// Opens `session`: shows it at once from the transcript cache, emitting
	/// [`StoreEvent::ActiveSessionChanged`] and [`StoreEvent::TranscriptReset`],
	/// and asks the host for it. The host's transcript replaces the cached
	/// one only when its revision or order differs.
	pub fn open_session(&mut self, session: SessionId, cx: &mut Context<Self>) -> RequestId {
		let surface = SurfaceId::QueueSessionRow(session.clone());
		let request = self.dispatch(HostAction::OpenSession { session: session.clone() }, surface, cx);
		self.pending_open = Some((request, session.clone()));
		let mut batch = Batch::default();
		self.show(session, &mut batch);
		for event in self.finish(batch) {
			cx.emit(event);
		}
		request
	}

	/// Creates a session in `cwd`, or in the host's working directory for
	/// `None`.
	pub fn create_session(&mut self, cwd: Option<String>, cx: &mut Context<Self>) -> RequestId {
		self.dispatch(
			HostAction::CreateSession { workspace: cwd, title: None },
			SurfaceId::NewSessionButton,
			cx,
		)
	}
}

