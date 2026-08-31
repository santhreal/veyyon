//! Session draft retention and typed attachment submission projection.

use super::helpers::*;
use crate::{
	command::UiCommand,
	host::{HostAction, HostEvent, SnapshotSection},
	model::*,
	navigation::{AttachmentKind, AttachmentState, LocalAttachment},
	store::Store,
};

#[test]
fn drafts_are_retained_per_session_and_clear_only_on_correlated_success() {
	let mut store = Store::detached();
	let first = sid("first");
	let second = sid("second");
	store.dispatch(UiCommand::EditDraft { session: first.clone(), text: "one".to_owned() });
	store.dispatch(UiCommand::EditDraft { session: second.clone(), text: "two".to_owned() });
	store.frontend.selected_session = Some(second.clone());
	assert_eq!(
		store
			.frontend
			.drafts
			.get(&first)
			.map(|draft| draft.text.as_str()),
		Some("one")
	);
	assert_eq!(
		store
			.frontend
			.drafts
			.get(&second)
			.map(|draft| draft.text.as_str()),
		Some("two")
	);
}

#[test]
fn typed_attachment_submissions_project_from_draft() {
	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "local".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::TurnControl,
		CapabilityStatus::Available,
	)])));

	let s = sid("session-att");
	let aid1 = AttachmentId::new("att-1").unwrap_or_else(|_| panic!("valid id"));
	let aid2 = AttachmentId::new("att-2").unwrap_or_else(|_| panic!("valid id"));

	let draft = store.frontend.drafts.entry(s.clone()).or_default();
	draft.text = "Please check this code".to_owned();
	draft
		.attachments
		.push(LocalAttachment::new(aid1.clone(), AttachmentKind::File {
			path: "/src/main.rs".to_owned(),
		}));
	let mut failed_att = LocalAttachment::new(aid2, AttachmentKind::Image {
		path: "/assets/logo.png".to_owned(),
		alt:  Some("Logo".to_owned()),
	});
	failed_att.state =
		AttachmentState::Failed { message: "upload failed".to_owned(), retryable: true };
	draft.attachments.push(failed_att);

	let effects = store.dispatch(UiCommand::SubmitPrompt { session: s.clone() });
	assert_eq!(effects.requests.len(), 1);
	if let HostAction::SubmitPrompt { session, text, attachments } = &effects.requests[0].action {
		assert_eq!(session, &s);
		assert_eq!(text, "Please check this code");
		assert_eq!(attachments.len(), 1);
		assert_eq!(attachments[0].id, aid1);
		assert_eq!(attachments[0].source, AttachmentSource::File { path: "/src/main.rs".to_owned() });
	} else {
		panic!("expected SubmitPrompt action");
	}

	let req_id = effects.requests[0].id;
	store.apply(HostEvent::RequestSucceeded { request: req_id });
	let cleared = store
		.frontend
		.drafts
		.get(&s)
		.unwrap_or_else(|| panic!("draft exists"));
	assert!(cleared.text.is_empty());
	assert!(cleared.attachments.is_empty());
}
