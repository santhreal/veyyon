//! An opened session stays shown only while the host has not refused it.
//!
//! A refusal, or a deadline the host lets pass, hands the window, the
//! sidebar's selection and rename field, and the regions' layout back to the
//! session the host holds active, and the window follows the host again once
//! no open is in flight.
//!
//! WHY: the window shows an opened session before the host answers, so the
//! answer decides whether it stays. A refusal that leaves the candidate
//! displayed shows, selects and renames a session the host never opened, and
//! lays the regions out for it. An answer to another request that settles the
//! open reverts a session the host is still opening. A refused open that
//! still counts as in flight makes the window ignore every session the host
//! makes active afterwards. A departing session whose layout was not recorded
//! before the switch comes back laid out as it was before the change.
//!
//! Gap: the window switches before the host answers, by design, so a pending
//! open does expand the block it is listed in; only the settled state is
//! asserted. A host header naming a session is followed whenever no open is in
//! flight, including one that arrives after its open's deadline. The binary's
//! transport and the layout file it writes are not driven.

mod layout;
mod rail;

use veyyon_desktop_model::{
	BackendError, ErrorScope, HostEvent, RequestId, SessionHeaderView, SessionId, SessionStatus,
	SessionSummary, SnapshotSection, Versioned,
};

fn sid(id: &str) -> SessionId {
	SessionId::from(id)
}

fn summary(id: &str, cwd: &str, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: cwd.to_owned(),
		title: Some(format!("title {id}")),
		parent_path: None,
		created_at_ms: 0,
		modified_at_ms,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

/// The host listing `a` and `b` under `/w/alpha` and `c` under `/w/beta`.
fn listing() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned {
			revision: 1,
			value:    vec![
				summary("a", "/w/alpha", 100),
				summary("b", "/w/alpha", 200),
				summary("c", "/w/beta", 50),
			],
		},
		Vec::new(),
	))
}

/// The host reporting `id` as its active session.
fn active(id: &str, cwd: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision: 1,
		value:    SessionHeaderView {
			id:             sid(id),
			schema_version: 1,
			title:          Some(format!("title {id}")),
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            cwd.to_owned(),
			mode:           None,
		},
	}))
}

/// The host refusing `request`.
fn refused(request: RequestId) -> HostEvent {
	HostEvent::RequestFailed {
		request,
		error: BackendError {
			scope:          ErrorScope::Session,
			code:           Some("not_found".to_owned()),
			message:        "The session could not be opened.".to_owned(),
			retryable:      false,
			request:        Some(request),
			occurred_at_ms: 0,
		},
	}
}
