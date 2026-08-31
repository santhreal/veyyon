//! // WHY: Attachment lifecycle transitions (add, remove, retry, submit) were
//! // previously untested against the full composer store dispatch path.
//! // This suite closes the class of broken draft attachment lifecycles by
//! // testing the end-to-end flow: adding then removing attachments leaves
//! // the draft empty, failed attachments can be retried, and prompt submission
//! // carries exactly the attachments shown in the draft.
//! // What it does not catch: remote network transport failures during upload.

use veyyon_gui_core::{
	Store, UiCommand,
	host::{HostAction, HostEvent, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState, SessionId},
	navigation::{AttachmentKind, AttachmentState},
};

fn test_session() -> SessionId {
	SessionId::new("lifecycle-session").expect("valid session id")
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
fn add_then_remove_leaves_draft_with_no_attachment() {
	let session = test_session();
	let mut store = connected_store(&session);

	store.dispatch(UiCommand::AddAttachment {
		session: session.clone(),
		kind:    AttachmentKind::File { path: "/repo/doc.pdf".to_owned() },
	});

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert_eq!(draft.attachments.len(), 1);
	let attachment_id = draft.attachments[0].id.clone();

	store.dispatch(UiCommand::RemoveAttachment {
		session:    session.clone(),
		attachment: attachment_id,
	});

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert!(draft.attachments.is_empty(), "draft must have no attachments after remove");
}

#[test]
fn failed_attachment_can_be_retried() {
	let session = test_session();
	let mut store = connected_store(&session);

	store.dispatch(UiCommand::AddAttachment {
		session: session.clone(),
		kind:    AttachmentKind::Image { path: "/repo/image.png".to_owned(), alt: None },
	});

	let draft = store
		.frontend
		.drafts
		.get_mut(&session)
		.expect("draft exists");
	assert_eq!(draft.attachments.len(), 1);
	let att_id = draft.attachments[0].id.clone();
	draft.attachments[0].state = AttachmentState::Failed {
		message:   "Connection timeout during upload".to_owned(),
		retryable: true,
	};

	store.dispatch(UiCommand::RetryAttachment {
		session:    session.clone(),
		attachment: att_id.clone(),
	});

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert_eq!(draft.attachments.len(), 1);
	assert_eq!(
		draft.attachments[0].state,
		AttachmentState::Selected,
		"retried attachment must be in Selected state"
	);
}

#[test]
fn submission_carries_exactly_draft_attachments_and_clears_on_success() {
	let session = test_session();
	let mut store = connected_store(&session);

	store.dispatch(UiCommand::EditDraft {
		session: session.clone(),
		text:    "Look at these files".to_owned(),
	});

	store.dispatch(UiCommand::AddAttachment {
		session: session.clone(),
		kind:    AttachmentKind::File { path: "/repo/first.rs".to_owned() },
	});
	store.dispatch(UiCommand::AddAttachment {
		session: session.clone(),
		kind:    AttachmentKind::Image {
			path: "/repo/second.png".to_owned(),
			alt:  Some("diagram".to_owned()),
		},
	});

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert_eq!(draft.attachments.len(), 2);
	let first_id = draft.attachments[0].id.clone();
	let second_id = draft.attachments[1].id.clone();

	let effects = store.dispatch(UiCommand::SubmitPrompt { session: session.clone() });
	assert_eq!(effects.requests.len(), 1);

	if let HostAction::SubmitPrompt { text, attachments, .. } = &effects.requests[0].action {
		assert_eq!(text, "Look at these files");
		assert_eq!(attachments.len(), 2);
		assert_eq!(attachments[0].id, first_id);
		assert_eq!(attachments[1].id, second_id);
	} else {
		panic!("expected SubmitPrompt action");
	}

	let req_id = effects.requests[0].id;
	store.apply(HostEvent::RequestSucceeded { request: req_id });

	let draft = store.frontend.drafts.get(&session).expect("draft exists");
	assert!(draft.text.is_empty());
	assert!(draft.attachments.is_empty(), "attachments must be cleared after successful send");
}
