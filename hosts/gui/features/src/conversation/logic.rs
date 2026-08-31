//! Pure session-shelf decisions.

use veyyon_gui_core::model::{SessionId, SessionStatus, SessionSummary};

/// Cold history is intentionally bounded. Loading another page is an explicit
/// command instead of an ever-growing render tree.
pub const HISTORY_PAGE_ROWS: usize = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shelf {
	Pinned,
	Active,
	History,
}

/// Put a session in the one shelf that describes its current state.
pub fn shelf_for(session: &SessionSummary, pinned: bool, selected: Option<&SessionId>) -> Shelf {
	if pinned {
		Shelf::Pinned
	} else if selected == Some(&session.id) || matches!(session.status, SessionStatus::Pending) {
		Shelf::Active
	} else {
		Shelf::History
	}
}

/// The title shown in a row is always engine data. A missing title falls back
/// to the first message and then the persisted path, never fabricated work.
pub fn row_title(session: &SessionSummary) -> &str {
	session
		.title
		.as_deref()
		.filter(|title| !title.trim().is_empty())
		.or_else(|| {
			session
				.first_message
				.as_deref()
				.and_then(|message| message.lines().find(|line| !line.trim().is_empty()))
		})
		.unwrap_or(session.path.as_str())
}

/// Search every canonical session-list field that contains human-readable
/// context. ASCII folding performs no render-time allocation.
pub fn matches_filter(session: &SessionSummary, query: &str) -> bool {
	let query = query.trim();
	if query.is_empty() {
		return true;
	}
	[
		session.title.as_deref(),
		Some(session.path.as_str()),
		Some(session.cwd.as_str()),
		session.first_message.as_deref(),
		session.searchable_messages.as_deref(),
	]
	.into_iter()
	.flatten()
	.any(|candidate| contains_case_insensitive(candidate, query))
}

fn contains_case_insensitive(candidate: &str, query: &str) -> bool {
	if !candidate.is_ascii() || !query.is_ascii() {
		return candidate.contains(query);
	}
	let query = query.as_bytes();
	candidate
		.as_bytes()
		.windows(query.len())
		.any(|window| window.eq_ignore_ascii_case(query))
}

pub fn status_label(status: SessionStatus) -> &'static str {
	match status {
		SessionStatus::Complete => "Complete",
		SessionStatus::Interrupted => "Interrupted",
		SessionStatus::Aborted => "Aborted",
		SessionStatus::Error => "Error",
		SessionStatus::Pending => "Active",
		SessionStatus::Unknown => "Status unavailable",
	}
}

#[cfg(test)]
mod tests {
	use veyyon_gui_core::model::{SessionId, WorkspaceId};

	use super::*;

	fn summary() -> SessionSummary {
		SessionSummary {
			id:                  SessionId::new("session").expect("valid id"),
			workspace:           WorkspaceId::new("workspace").expect("valid id"),
			path:                "/repo/session.jsonl".to_owned(),
			cwd:                 "/repo".to_owned(),
			title:               Some("Review renderer".to_owned()),
			parent_path:         None,
			created_at_ms:       1,
			modified_at_ms:      2,
			message_count:       3,
			size_bytes:          4,
			first_message:       Some("Inspect clipping".to_owned()),
			searchable_messages: Some("narrow layout".to_owned()),
			status:              SessionStatus::Complete,
		}
	}

	#[test]
	fn filtering_uses_row_and_message_context_without_case_sensitivity() {
		let session = summary();
		for query in ["REVIEW", "repo/session", "CLIPPING", "narrow"] {
			assert!(matches_filter(&session, query), "{query} must find the session");
		}
		assert!(!matches_filter(&session, "provider"));
	}

	#[test]
	fn pinned_and_selected_shelves_have_stable_precedence() {
		let session = summary();
		assert_eq!(shelf_for(&session, true, Some(&session.id)), Shelf::Pinned);
		assert_eq!(shelf_for(&session, false, Some(&session.id)), Shelf::Active);
		assert_eq!(shelf_for(&session, false, None), Shelf::History);
	}
}
