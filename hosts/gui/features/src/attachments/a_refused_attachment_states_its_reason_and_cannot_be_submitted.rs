//! // WHY: Attachments previously had no refusal feedback or capability gating,
//! // allowing unsupported modalities, oversized files, or attachments to
//! // unavailable models to be silently dropped or fail unexpectedly on send.
//! // This suite closes the class of uncommunicated attachment refusals by
//! // ensuring every refusal reason has human-readable explanation text, is
//! // derived from store capability/model state, and strictly prevents prompt
//! // submission.
//! // What it does not catch: backend transport/network drops occurring after
//! // successful submission dispatch.

use veyyon_gui_core::{
	Store, UiCommand,
	host::{HostAction, HostEvent, SnapshotSection},
	model::{
		AttachmentId, AttachmentRefusalReason, Availability, Capability, CapabilityStatus,
		ConnectionState, ModelCatalogState, ModelId, ModelOption, PromptConstraints, ProviderId,
		RemoteData, SessionId, SessionRuntimeView, Versioned,
	},
	navigation::{AttachmentKind, AttachmentState, LocalAttachment},
};

use crate::composer::logic::{Blocked, GateContext, blocked};

fn test_session() -> SessionId {
	SessionId::new("test-session").expect("valid session id")
}

fn connected_store(session: &SessionId) -> Store {
	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "local".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::TurnControl,
		CapabilityStatus::Available,
	)])));
	store.frontend.selected_session = Some(session.clone());
	store
}

#[test]
fn every_refusal_cause_produces_non_empty_reason_text() {
	let all_causes = AttachmentRefusalReason::all_examples();
	assert_eq!(all_causes.len(), 5);

	for cause in &all_causes {
		let text = cause.reason_text();
		assert!(!text.trim().is_empty(), "reason_text must not be empty for {cause:?}");

		match cause {
			AttachmentRefusalReason::UnsupportedModality { modality } => {
				assert!(text.contains(modality));
			},
			AttachmentRefusalReason::UnsupportedType { mime } => {
				assert!(text.contains(mime));
			},
			AttachmentRefusalReason::SizeExceeded { .. } => {
				assert!(text.contains("exceeds model limit"));
			},
			AttachmentRefusalReason::TooManyAttachments { count, max } => {
				assert!(text.contains(&count.to_string()));
				assert!(text.contains(&max.to_string()));
			},
			AttachmentRefusalReason::ModelUnavailable { reason } => {
				assert!(text.contains(reason));
			},
		}
	}
}

#[test]
fn refused_attachment_blocks_submission_and_cannot_be_submitted() {
	let session = test_session();
	let mut store = connected_store(&session);

	let att_id = AttachmentId::new("att-refused").expect("valid id");
	let mut att = LocalAttachment::new(att_id.clone(), AttachmentKind::File {
		path: "/repo/huge_binary.bin".to_owned(),
	});
	att.size_bytes = Some(100 * 1024 * 1024);
	att.state = AttachmentState::Refused {
		reason: AttachmentRefusalReason::SizeExceeded {
			size_bytes: 100 * 1024 * 1024,
			max_bytes:  20 * 1024 * 1024,
		},
	};

	assert_eq!(att.submission(), None);

	let draft = store.frontend.drafts.entry(session.clone()).or_default();
	draft.text = "Hello with oversized attachment".to_owned();
	draft.attachments.push(att);

	assert!(draft.submission_attachments().is_empty());

	let gate = GateContext {
		connected:         true,
		provider_error:    None,
		invalid_reason:    None,
		max_characters:    None,
		max_attachments:   None,
		required_decision: None,
	};
	let is_blocked = blocked(Some(draft), gate);
	assert!(matches!(is_blocked, Some(Blocked::AttachmentRefused(_))));

	let effects = store.dispatch(UiCommand::SubmitPrompt { session: session.clone() });
	if let Some(req) = effects.requests.first()
		&& let HostAction::SubmitPrompt { attachments, .. } = &req.action
	{
		assert!(attachments.is_empty(), "refused attachment must not be submitted");
	}
}

#[test]
fn store_refuses_attachment_when_modalities_exclude_it() {
	let session = test_session();
	let mut store = connected_store(&session);

	let model_id = ModelId::new("text-only-model").expect("valid model id");
	let provider_id = ProviderId::new("test-provider").expect("valid provider id");

	let runtime = SessionRuntimeView {
		session:            session.clone(),
		file:               None,
		name:               None,
		provider:           Some(provider_id.clone()),
		model:              Some(model_id.clone()),
		thinking_level:     None,
		streaming:          false,
		compacting:         false,
		auto_compaction:    false,
		message_count:      0,
		queue:              veyyon_gui_core::model::QueueState {
			count:             0,
			steering:          veyyon_gui_core::model::QueueDelivery::Immediate,
			follow_up:         veyyon_gui_core::model::QueueDelivery::Queued,
			interrupt:         veyyon_gui_core::model::InterruptMode::AbortThenSend,
			active_submission: veyyon_gui_core::model::SubmissionMode::Prompt,
		},
		todos:              Vec::new(),
		context:            None,
		turn:               veyyon_gui_core::model::TurnState::Idle,
		prompt_constraints: PromptConstraints {
			max_characters:       None,
			max_attachments:      None,
			max_attachment_bytes: None,
			allowed_modalities:   vec!["text".to_owned()],
			validation_error:     None,
		},
	};
	store.apply(HostEvent::Snapshot(SnapshotSection::Runtime(Versioned {
		revision: 1,
		value:    runtime,
	})));

	let model_opt = ModelOption {
		id:                   model_id,
		provider:             provider_id,
		name:                 "Text Only Model".to_owned(),
		context_window:       Some(128_000),
		max_attachment_bytes: Some(10 * 1024 * 1024),
		reasoning:            false,
		thinking_mode:        None,
		supported_efforts:    Vec::new(),
		default_effort:       None,
		input_modalities:     vec!["text".to_owned()],
		tool_support:         Some(true),
		availability:         Availability::Available,
	};
	store.apply(HostEvent::Snapshot(SnapshotSection::Models(Versioned {
		revision: 1,
		value:    ModelCatalogState {
			models:   RemoteData::Ready(vec![model_opt]),
			selected: None,
			thinking: veyyon_gui_core::model::ThinkingSelection {
				configured:        None,
				effective:         None,
				supported_efforts: Vec::new(),
				default:           None,
			},
			refresh:  veyyon_gui_core::model::CommandState::Idle,
		},
	})));

	store.dispatch(UiCommand::AddAttachment {
		session: session.clone(),
		kind:    AttachmentKind::Image { path: "screenshot.png".to_owned(), alt: None },
	});

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert_eq!(draft.attachments.len(), 1);
	let item = &draft.attachments[0];
	assert!(
		matches!(&item.state, AttachmentState::Refused {
			reason: AttachmentRefusalReason::UnsupportedModality { .. },
		}),
		"image attachment must be refused when model/constraints only accept text"
	);
}

#[test]
fn store_refuses_attachment_when_size_exceeds_bound() {
	let session = test_session();
	let mut store = connected_store(&session);

	let runtime = SessionRuntimeView {
		session:            session.clone(),
		file:               None,
		name:               None,
		provider:           None,
		model:              None,
		thinking_level:     None,
		streaming:          false,
		compacting:         false,
		auto_compaction:    false,
		message_count:      0,
		queue:              veyyon_gui_core::model::QueueState {
			count:             0,
			steering:          veyyon_gui_core::model::QueueDelivery::Immediate,
			follow_up:         veyyon_gui_core::model::QueueDelivery::Queued,
			interrupt:         veyyon_gui_core::model::InterruptMode::AbortThenSend,
			active_submission: veyyon_gui_core::model::SubmissionMode::Prompt,
		},
		todos:              Vec::new(),
		context:            None,
		turn:               veyyon_gui_core::model::TurnState::Idle,
		prompt_constraints: PromptConstraints {
			max_characters:       None,
			max_attachments:      None,
			max_attachment_bytes: Some(50),
			allowed_modalities:   Vec::new(),
			validation_error:     None,
		},
	};
	store.apply(HostEvent::Snapshot(SnapshotSection::Runtime(Versioned {
		revision: 1,
		value:    runtime,
	})));

	let long_text = "a".repeat(100);
	store.dispatch(UiCommand::AddAttachment {
		session: session.clone(),
		kind:    AttachmentKind::TextRange {
			path:       "test.rs".to_owned(),
			start_line: 1,
			end_line:   10,
			text:       long_text,
		},
	});

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert_eq!(draft.attachments.len(), 1);
	let item = &draft.attachments[0];
	assert!(
		matches!(&item.state, AttachmentState::Refused {
			reason: AttachmentRefusalReason::SizeExceeded { size_bytes: 100, max_bytes: 50 },
		}),
		"oversized text attachment must be refused"
	);
}
