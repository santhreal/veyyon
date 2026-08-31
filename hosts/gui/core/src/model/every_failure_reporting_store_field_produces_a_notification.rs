//! WHY. Every error or failure path in the Store replica must route to a
//! visible notification rather than landing in a silent unobserved field.
//!
//! WHAT THIS DOES NOT CATCH. In-band diagnostic notices which belong
//! exclusively to the diagnostics panel.

use std::collections::BTreeSet;

use crate::{
	host::HostEvent,
	model::*,
	store::{CommandTarget, Effects, Store},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum FailureSource {
	RequestFailed,
	FileReadFailed,
	FatalProtocolError,
	ConnectionFailed,
	ToolError,
	DiagnosticNotice,
}

impl FailureSource {
	const ALL: [Self; 6] = [
		Self::RequestFailed,
		Self::FileReadFailed,
		Self::FatalProtocolError,
		Self::ConnectionFailed,
		Self::ToolError,
		Self::DiagnosticNotice,
	];
}

#[test]
fn every_failure_reporting_store_field_produces_a_notification() {
	// Pinned opt-out list asserted by exact equality: DiagnosticNotice is an
	// in-band notice panel item rather than an immediate floating notification.
	let opt_outs: BTreeSet<FailureSource> = [FailureSource::DiagnosticNotice].into_iter().collect();
	assert_eq!(opt_outs, [FailureSource::DiagnosticNotice].into_iter().collect());

	for source in FailureSource::ALL {
		if opt_outs.contains(&source) {
			continue;
		}

		let mut store = Store::detached();
		match source {
			FailureSource::RequestFailed => {
				let req = RequestId::FIRST;
				let action = crate::host::HostAction::Detach;
				let mut effects = Effects::default();
				store.emit(
					action,
					CommandTarget::Connection,
					crate::store::Completion::None,
					&mut effects,
				);
				store.apply(HostEvent::RequestFailed {
					request: req,
					error:   BackendError {
						scope:          ErrorScope::Lifecycle,
						code:           Some("ERR".into()),
						message:        "Failed to detach".into(),
						retryable:      false,
						request:        Some(req),
						occurred_at_ms: 0,
					},
				});
				assert!(!store.replica.notifications.is_empty(), "RequestFailed did not notify");
			},
			FailureSource::FileReadFailed => {
				let req = RequestId::FIRST;
				let action = crate::host::HostAction::ReadFile {
					file:  FileId::new("test.rs").unwrap(),
					range: None,
				};
				let mut effects = Effects::default();
				store.emit(action, CommandTarget::Files, crate::store::Completion::None, &mut effects);
				store.apply(HostEvent::RequestFailed {
					request: req,
					error:   BackendError {
						scope:          ErrorScope::File,
						code:           Some("NOT_FOUND".into()),
						message:        "No such file".into(),
						retryable:      false,
						request:        Some(req),
						occurred_at_ms: 0,
					},
				});
				assert!(
					store
						.replica
						.notifications
						.entries()
						.iter()
						.any(|n| n.title == "File read failed"),
					"FileReadFailed did not produce a file read failure notification"
				);
			},
			FailureSource::FatalProtocolError => {
				store.apply(HostEvent::FatalProtocolError {
					message: "Protocol stream corrupted".into(),
				});
				assert!(
					store
						.replica
						.notifications
						.entries()
						.iter()
						.any(|n| n.title == "Fatal protocol error"),
					"FatalProtocolError did not notify"
				);
			},
			FailureSource::ConnectionFailed => {
				store.apply(HostEvent::ConnectionChanged(ConnectionState::Fatal {
					message: "Connection refused".into(),
				}));
				assert!(
					store
						.replica
						.notifications
						.entries()
						.iter()
						.any(|n| n.title == "Connection dropped"),
					"ConnectionFailed did not notify"
				);
			},
			FailureSource::ToolError => {
				store.apply(HostEvent::ToolUpdated {
					revision: 1,
					tool:     ToolCallView {
						id:            ToolId::new("tool-1").unwrap(),
						name:          "bash".into(),
						intent:        Some("Run script".into()),
						arguments:     Value::Null,
						state:         ToolState::Failed,
						result:        None,
						is_error:      true,
						started_at_ms: None,
						ended_at_ms:   None,
					},
				});
				assert!(
					store
						.replica
						.notifications
						.entries()
						.iter()
						.any(|n| n.tone == NotificationTone::Error),
					"ToolError did not notify"
				);
			},
			FailureSource::DiagnosticNotice => unreachable!(),
		}
	}
}
