//! Terminal output stream accumulation and file read error preservation.

use super::helpers::*;
use crate::{
	command::UiCommand,
	host::{HostEvent, SnapshotSection},
	model::*,
	store::Store,
};

#[test]
fn terminal_output_accumulates_raw_bytes_and_creates_missing_runs() {
	let mut store = Store::detached();
	let term = tid("term-1");
	store.apply(HostEvent::Snapshot(SnapshotSection::Terminals(Versioned {
		revision: 1,
		value:    vec![TerminalRunView {
			id:          term.clone(),
			command:     "cargo test".to_owned(),
			cwd:         "/workspace".to_owned(),
			phase:       TerminalPhase::Running,
			output:      vec![b'a', b'b'],
			exit_code:   None,
			signal:      None,
			cancelled:   false,
			truncated:   false,
			total_lines: 1,
			total_bytes: 2,
			error:       None,
			artifact_id: None,
		}],
	})));

	store.apply(HostEvent::TerminalOutput {
		revision: 2,
		terminal: term.clone(),
		bytes:    vec![b'c', b'd'],
	});
	let runs = store
		.replica
		.terminals
		.readable()
		.map(|v| &v.value)
		.unwrap_or_else(|| panic!("expected runs"));
	assert_eq!(runs[0].output, vec![b'a', b'b', b'c', b'd']);
	assert_eq!(runs[0].total_bytes, 4);

	let term_new = tid("term-2");
	store.apply(HostEvent::TerminalOutput {
		revision: 3,
		terminal: term_new.clone(),
		bytes:    vec![b'x', b'y', b'z'],
	});
	let runs = store
		.replica
		.terminals
		.readable()
		.map(|v| &v.value)
		.unwrap_or_else(|| panic!("expected runs"));
	assert_eq!(runs.len(), 2);
	assert_eq!(runs[1].id, term_new);
	assert_eq!(runs[1].output, vec![b'x', b'y', b'z']);
}

#[test]
fn file_read_error_kind_and_error_preservation() {
	assert_eq!(FileReadErrorKind::from_code("not_found"), FileReadErrorKind::NotFound);
	assert_eq!(FileReadErrorKind::from_code("NotFound"), FileReadErrorKind::NotFound);
	assert_eq!(
		FileReadErrorKind::from_code("permission_denied"),
		FileReadErrorKind::PermissionDenied
	);
	assert_eq!(FileReadErrorKind::from_code("binary"), FileReadErrorKind::Binary);
	assert_eq!(FileReadErrorKind::from_code("too_large"), FileReadErrorKind::TooLarge);
	assert_eq!(FileReadErrorKind::from_code("transport"), FileReadErrorKind::Transport);
	assert_eq!(FileReadErrorKind::from_code("anything_else"), FileReadErrorKind::Other);

	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "local".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
		Capability::Files,
		CapabilityStatus::Available,
	)])));

	let file = fid("file-1");
	store.apply(HostEvent::Snapshot(SnapshotSection::Files(Versioned {
		revision: 1,
		value:    FileWorkspaceState {
			roots:         vec![],
			nodes:         vec![],
			selected_read: RemoteData::Unrequested,
			read_error:    None,
			search:        RemoteData::Unrequested,
		},
	})));

	let effects = store.dispatch(UiCommand::ReadFile { file: file.clone(), range: None });
	assert_eq!(effects.requests.len(), 1);
	let req_id = effects.requests[0].id;

	store.apply(HostEvent::RequestFailed {
		request: req_id,
		error:   BackendError {
			scope:          ErrorScope::File,
			code:           Some("permission_denied".to_owned()),
			message:        "Cannot open file".to_owned(),
			retryable:      false,
			request:        None,
			occurred_at_ms: 100,
		},
	});

	let files = store
		.replica
		.files
		.readable()
		.unwrap_or_else(|| panic!("files state exists"));
	let err = files
		.value
		.read_error
		.as_ref()
		.unwrap_or_else(|| panic!("read_error set"));
	assert_eq!(err.kind, FileReadErrorKind::PermissionDenied);
	assert_eq!(err.message, "Cannot open file");
	assert_eq!(err.path, file.as_str());
}
