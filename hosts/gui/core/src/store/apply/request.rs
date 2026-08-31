//! Request completion and pending state retirement.

use crate::{
	model::*,
	store::{Changes, CommandTarget, Completion, Store},
};

impl Store {
	pub(super) fn finish_request(
		&mut self,
		request: RequestId,
		error: Option<BackendError>,
		changes: &mut Changes,
	) {
		let Some(pending) = self.pending.remove(&request) else {
			changes.ignored_stale_event = true;
			return;
		};
		changes.completed_request = Some(request);
		match error {
			Some(error) => {
				self
					.command_states
					.insert(pending.target.clone(), CommandState::Failed {
						request,
						message: error.message.clone(),
					});
				self.replica.errors.push(error.clone());
				if let Completion::ClearDraft(session) = pending.completion
					&& let Some(draft) = self.frontend.drafts.get_mut(&session)
				{
					draft.submission = self
						.command_states
						.get(&pending.target)
						.cloned()
						.unwrap_or_default();
				}
				if pending.target == CommandTarget::Files
					&& let RemoteData::Ready(files) | RemoteData::Stale { value: files, .. } =
						&mut self.replica.files
				{
					let kind = error
						.code
						.as_deref()
						.map(FileReadErrorKind::from_code)
						.unwrap_or(FileReadErrorKind::Other);
					files.value.read_error = Some(FileReadError {
						path: self
							.frontend
							.selected_file
							.as_ref()
							.map(|f| f.as_str().to_owned())
							.unwrap_or_default(),
						kind,
						message: error.message.clone(),
						retryable: error.retryable,
					});
				}
				let id = self.replica.notifications.next_id();
				let (key, title) = if pending.target == CommandTarget::Files {
					("file-read-error".to_string(), "File read failed".to_string())
				} else {
					(
						format!("request-failed:{:?}", pending.target),
						format!("Request failed: {:?}", pending.target),
					)
				};
				let mut notification =
					Notification::new(id, NotificationKey::new(key), NotificationTone::Error, title, 0);
				notification.detail = Some(error.message);
				self.replica.notifications.push(notification);
				changes.replica = true;
				changes.frontend = true;
			},
			None => {
				self
					.command_states
					.insert(pending.target, CommandState::Idle);
				match pending.completion {
					Completion::None => {},
					Completion::ClearDraft(session) => {
						if let Some(draft) = self.frontend.drafts.get_mut(&session) {
							draft.text.clear();
							draft.caret = 0;
							draft.selection = None;
							draft.attachments.clear();
							draft.submission = CommandState::Idle;
						}
						changes.frontend = true;
					},
					Completion::CloseInteraction(interaction) => {
						self.frontend.interaction_drafts.remove(&interaction);
						self.frontend.overlays.retain(|overlay| {
							!matches!(overlay, crate::navigation::Overlay::Approval { interaction: id } | crate::navigation::Overlay::Question { interaction: id } if id == &interaction)
						});
						changes.frontend = true;
					},
				}
			},
		}
	}
}
