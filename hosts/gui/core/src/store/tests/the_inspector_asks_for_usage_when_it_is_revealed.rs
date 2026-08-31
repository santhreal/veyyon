//! WHY: the inspector's context tab showed "Usage not requested" and a button,
//! so the numbers a reader opened the panel for arrived only after a second
//! deliberate action. Revealing the panel now asks for them.
//!
//! The class this closes is the automatic request: a request nobody typed must
//! be silent, must not repeat, and must not fire for a host that cannot answer.
//! Every reveal path is covered — the toggle and each tab selection — because a
//! mechanism wired to one of them and not the others is the recurring defect
//! here.
//!
//! Not covered: whether the host answers, and what the panel renders once it
//! does. Those are the snapshot tests.

use crate::{
	command::UiCommand,
	host::{HostAction, HostRequest},
	model::{Capability, CapabilityStatus, ConnectionState, RemoteData},
	navigation::InspectorTab,
	store::{CommandTarget, Effects, ShellEffect, Store},
};

fn connected() -> Store {
	let mut store = Store::detached();
	store.connection = ConnectionState::Connected { endpoint: "test".to_owned(), protocol: 1 };
	store.replica.capabilities = [(Capability::Usage, CapabilityStatus::Available)]
		.into_iter()
		.collect();
	store.frontend.panels.inspector_open = false;
	store.frontend.inspector_tab = InspectorTab::Context;
	store
}

fn usage_requests(effects: &Effects) -> usize {
	effects
		.requests
		.iter()
		.filter(|request| matches!(request.action, HostAction::GetUsage))
		.count()
}

/// Every tab the inspector can be revealed on, taken from the enum rather than
/// a list written here: a new tab makes this test decide whether it asks for
/// usage instead of silently inheriting an answer.
fn tabs() -> Vec<InspectorTab> {
	[InspectorTab::Context, InspectorTab::Details, InspectorTab::Outline]
		.into_iter()
		.map(|tab| match tab {
			InspectorTab::Context | InspectorTab::Details | InspectorTab::Outline => tab,
		})
		.collect()
}

#[test]
fn opening_the_inspector_on_the_context_tab_asks_for_usage_once() {
	let mut store = connected();
	let effects = store.dispatch(UiCommand::ToggleInspector);
	assert!(store.frontend.panels.inspector_open);
	assert_eq!(usage_requests(&effects), 1);
	// The request is in flight, which is the signal that stops a second one:
	// the replica still holds nothing, so `Unrequested` alone would ask again on
	// every reveal until the host answered.
	assert!(store.request_pending(&CommandTarget::Usage));

	// A close asks for nothing, and a reveal while the request is in flight
	// asks for nothing either.
	let closed = store.dispatch(UiCommand::ToggleInspector);
	assert_eq!(usage_requests(&closed), 0);
	let reopened = store.dispatch(UiCommand::ToggleInspector);
	assert_eq!(usage_requests(&reopened), 0);
	let retabbed = store.dispatch(UiCommand::SetInspectorTab(InspectorTab::Context));
	assert_eq!(usage_requests(&retabbed), 0);
}

#[test]
fn only_the_tab_that_shows_usage_asks_for_it() {
	for tab in tabs() {
		let mut store = connected();
		let effects = store.dispatch(UiCommand::SetInspectorTab(tab));
		let expected = usize::from(tab == InspectorTab::Context);
		assert_eq!(
			usage_requests(&effects),
			expected,
			"{tab:?} asked for usage {} times",
			usage_requests(&effects)
		);
	}
}

#[test]
fn a_closed_inspector_asks_for_nothing() {
	let mut store = connected();
	store.frontend.panels.inspector_open = true;
	let effects = store.dispatch(UiCommand::ToggleInspector);
	assert!(!store.frontend.panels.inspector_open);
	assert_eq!(usage_requests(&effects), 0);
	assert!(matches!(store.replica.usage, RemoteData::Unrequested));
}

#[test]
fn a_host_that_cannot_answer_is_not_asked_and_reports_nothing() {
	let refusals = [
		(ConnectionState::Detached, CapabilityStatus::Available),
		(
			ConnectionState::Connected { endpoint: "test".to_owned(), protocol: 1 },
			CapabilityStatus::Unavailable { reason: "no usage here".to_owned() },
		),
		(
			ConnectionState::Connected { endpoint: "test".to_owned(), protocol: 1 },
			CapabilityStatus::UnknownUntilAttached,
		),
	];
	for (connection, status) in refusals {
		let mut store = Store::detached();
		store.connection = connection.clone();
		if !matches!(status, CapabilityStatus::UnknownUntilAttached) {
			store.replica.capabilities = [(Capability::Usage, status.clone())].into_iter().collect();
		}
		let effects = store.dispatch(UiCommand::ToggleInspector);
		assert_eq!(usage_requests(&effects), 0, "{connection:?} with {status:?} was asked");
		// Silence is the contract: nothing asked for this request, so a refusal
		// notice would appear for an action the reader never took.
		assert!(
			!effects
				.shell
				.iter()
				.any(|effect| matches!(effect, ShellEffect::Notify { .. })),
			"{connection:?} with {status:?} reported a refusal"
		);
		assert!(matches!(store.replica.usage, RemoteData::Unrequested));
	}
}

#[test]
fn an_explicit_request_still_reaches_the_host() {
	let mut store = connected();
	let effects = store.dispatch(UiCommand::GetUsage);
	assert_eq!(usage_requests(&effects), 1);
	let _: &HostRequest = effects
		.requests
		.first()
		.unwrap_or_else(|| unreachable!("the request was counted"));
}
