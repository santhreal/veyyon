//! Composer decision contracts.

use veyyon_gui_core::{
	model::{
		AttachmentId, InterruptMode, PromptConstraints as RuntimeConstraints, QueueDelivery,
		QueueState, SessionId, SessionRuntimeView, SubmissionMode, TurnPhase, TurnState,
	},
	navigation::{AttachmentKind, AttachmentState, Draft, LocalAttachment},
};

use super::logic::{Blocked, GateContext, PLACEHOLDER, PrimaryAction, blocked, primary_action};

fn constraints() -> GateContext<'static> {
	GateContext {
		connected:         true,
		provider_error:    None,
		invalid_reason:    None,
		max_characters:    Some(10),
		max_attachments:   Some(2),
		required_decision: None,
	}
}

fn attachment(state: AttachmentState) -> LocalAttachment {
	let mut att = LocalAttachment::new(
		AttachmentId::new("attachment").expect("valid id"),
		AttachmentKind::File { path: "/repo/input.txt".to_owned() },
	);
	att.state = state;
	att
}

#[test]
fn invalid_and_oversize_drafts_remain_present_with_exact_reasons() {
	let draft = Draft { text: "retained draft".to_owned(), ..Draft::default() };
	assert_eq!(
		blocked(Some(&draft), constraints()),
		Some(Blocked::Oversize { characters: 14, maximum: 10 }),
	);
	assert_eq!(draft.text, "retained draft");

	let invalid =
		GateContext { invalid_reason: Some("The active model accepts text only"), ..constraints() };
	assert_eq!(
		blocked(Some(&draft), invalid),
		Some(Blocked::Invalid("The active model accepts text only")),
	);
	assert_eq!(draft.text, "retained draft");
}

#[test]
fn every_incomplete_attachment_blocks_send_in_place() {
	let cases = [
		(AttachmentState::Uploading { progress_milli: 500 }, Blocked::Uploading),
		(
			AttachmentState::Failed { message: "Upload rejected".to_owned(), retryable: true },
			Blocked::UploadFailed("Upload rejected"),
		),
		(
			AttachmentState::NeedsReattach { reason: "Local bytes are unavailable".to_owned() },
			Blocked::NeedsReattach("Local bytes are unavailable"),
		),
	];
	for (state, expected) in cases {
		let draft = Draft {
			text: "send".to_owned(),
			attachments: vec![attachment(state)],
			..Draft::default()
		};
		assert_eq!(blocked(Some(&draft), constraints()), Some(expected));
		assert_eq!(draft.text, "send");
		assert_eq!(draft.attachments.len(), 1);
	}
}

#[test]
fn a_required_decision_is_the_nearest_blocker() {
	let draft = Draft { text: "send".to_owned(), ..Draft::default() };
	let constraints = GateContext {
		connected: false,
		provider_error: Some("Provider unavailable"),
		required_decision: Some("Answer the pending question before sending"),
		..constraints()
	};
	assert_eq!(
		blocked(Some(&draft), constraints),
		Some(Blocked::RequiredDecision("Answer the pending question before sending")),
	);
}

#[test]
fn whitespace_without_context_has_nothing_to_send() {
	for text in ["", " ", "\t", "\n", "   \n\t "] {
		let draft = Draft { text: text.to_owned(), ..Draft::default() };
		assert_eq!(blocked(Some(&draft), constraints()), Some(Blocked::Empty));
	}
	let draft = Draft { attachments: vec![attachment(AttachmentState::Ready)], ..Draft::default() };
	assert_eq!(blocked(Some(&draft), constraints()), None);
}

#[test]
fn the_placeholder_is_a_short_instruction() {
	assert!(PLACEHOLDER.len() < 32);
	assert!(!PLACEHOLDER.ends_with('.'));
}

fn runtime(turn: TurnState, active_submission: SubmissionMode) -> SessionRuntimeView {
	SessionRuntimeView {
		session: SessionId::new("session").expect("valid id"),
		file: None,
		name: None,
		provider: None,
		model: None,
		thinking_level: None,
		streaming: !matches!(&turn, TurnState::Idle),
		compacting: matches!(&turn, TurnState::Compacting { .. }),
		auto_compaction: false,
		message_count: 0,
		queue: QueueState {
			count: 0,
			steering: QueueDelivery::Immediate,
			follow_up: QueueDelivery::Queued,
			interrupt: InterruptMode::AbortThenSend,
			active_submission,
		},
		todos: Vec::new(),
		context: None,
		turn,
		prompt_constraints: RuntimeConstraints {
			max_characters:       None,
			max_attachments:      None,
			max_attachment_bytes: None,
			allowed_modalities:   Vec::new(),
			validation_error:     None,
		},
	}
}

#[test]
fn primary_control_changes_only_with_confirmed_runtime() {
	assert_eq!(primary_action(None), PrimaryAction::Send);
	assert_eq!(
		primary_action(Some(&runtime(TurnState::Idle, SubmissionMode::FollowUp))),
		PrimaryAction::Send,
	);
	for (mode, expected) in [
		(SubmissionMode::Prompt, PrimaryAction::Abort),
		(SubmissionMode::Steer, PrimaryAction::Steer),
		(SubmissionMode::FollowUp, PrimaryAction::FollowUp),
	] {
		let running = runtime(
			TurnState::Running {
				turn_id:       Some("turn".to_owned()),
				started_at_ms: 1,
				phase:         TurnPhase::Responding,
			},
			mode,
		);
		assert_eq!(primary_action(Some(&running)), expected);
	}
}
