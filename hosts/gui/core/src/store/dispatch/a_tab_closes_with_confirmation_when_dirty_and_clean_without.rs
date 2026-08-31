//! WHY THIS SUITE EXISTS. Closing a tab must never discard uncommitted user
//! work without explicit confirmation. A dirty tab with an unsent draft or an
//! active in-flight engine turn must surface a confirmation overlay carrying
//! the force close command, while a clean tab must close immediately without
//! prompting.
//!
//! What this closes: silent loss of composer drafts or in-flight turns on tab
//! close. What it does not catch: OS-level application force-kill or window
//! closing without dock.

#[cfg(test)]
mod tests {
	use crate::{
		Store, UiCommand,
		model::{
			InterruptMode, PromptConstraints, QueueDelivery, QueueState, RemoteData, SessionId,
			SessionRuntimeView, SubmissionMode, TurnPhase, TurnState, Versioned,
		},
		navigation::{Draft, Overlay},
	};

	fn sample_session_id(name: &str) -> SessionId {
		SessionId::new(name).unwrap()
	}

	#[test]
	fn clean_tab_closes_immediately_without_confirmation() {
		let mut store = Store::detached();
		let s1 = sample_session_id("session-1");
		store.dispatch(UiCommand::OpenTab(s1.clone()));

		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 1);
		assert_eq!(store.frontend.selected_session, Some(s1));
		assert!(store.frontend.overlays.is_empty());

		// Dispatch non-forced close on clean tab
		store.dispatch(UiCommand::CloseTab { index: 0, force: false });

		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 0);
		assert_eq!(store.frontend.selected_session, None);
		assert!(store.frontend.overlays.is_empty());
	}

	#[test]
	fn dirty_tab_with_draft_text_prompts_and_closes_only_on_confirm() {
		let mut store = Store::detached();
		let s1 = sample_session_id("session-draft");
		store.dispatch(UiCommand::OpenTab(s1.clone()));

		// Add unsent draft text
		store.frontend.drafts.insert(s1.clone(), Draft {
			text: "Unsent message draft".to_owned(),
			..Default::default()
		});

		assert!(store.is_session_dirty(&s1));

		// Dispatch non-forced close: should prompt
		store.dispatch(UiCommand::CloseTab { index: 0, force: false });

		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 1);
		assert_eq!(store.frontend.overlays.len(), 1);

		let confirmation = match &store.frontend.overlays[0] {
			Overlay::Confirmation { confirm, .. } => confirm.clone(),
			other => panic!("expected Overlay::Confirmation, got {other:?}"),
		};

		// Confirm close
		store.dispatch(*confirmation);

		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 0);
		assert_eq!(store.frontend.selected_session, None);
	}

	#[test]
	fn dirty_tab_with_active_runtime_turn_prompts_confirmation() {
		let mut store = Store::detached();
		let s1 = sample_session_id("session-active");
		store.dispatch(UiCommand::OpenTab(s1.clone()));

		// Simulate active runtime turn
		store.replica.runtime = RemoteData::Ready(Versioned {
			revision: 1,
			value:    SessionRuntimeView {
				session:            s1.clone(),
				file:               None,
				name:               None,
				provider:           None,
				model:              None,
				thinking_level:     None,
				streaming:          true,
				compacting:         false,
				auto_compaction:    false,
				message_count:      1,
				queue:              QueueState {
					count:             0,
					steering:          QueueDelivery::Immediate,
					follow_up:         QueueDelivery::Immediate,
					interrupt:         InterruptMode::AbortThenSend,
					active_submission: SubmissionMode::Prompt,
				},
				todos:              Vec::new(),
				context:            None,
				turn:               TurnState::Running {
					turn_id:       None,
					started_at_ms: 100,
					phase:         TurnPhase::Thinking,
				},
				prompt_constraints: PromptConstraints {
					max_characters:       None,
					max_attachments:      None,
					max_attachment_bytes: None,
					allowed_modalities:   Vec::new(),
					validation_error:     None,
				},
			},
		});

		assert!(store.is_session_dirty(&s1));

		// Dispatch close: should prompt
		store.dispatch(UiCommand::CloseTab { index: 0, force: false });

		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 1);
		assert_eq!(store.frontend.overlays.len(), 1);

		let confirmation = match &store.frontend.overlays[0] {
			Overlay::Confirmation { confirm, .. } => confirm.clone(),
			other => panic!("expected Overlay::Confirmation, got {other:?}"),
		};

		// Execute confirmation
		store.dispatch(*confirmation);
		assert_eq!(store.frontend.spaces.active().unwrap().tabs.len(), 0);
		assert_eq!(store.frontend.selected_session, None);
	}
}
