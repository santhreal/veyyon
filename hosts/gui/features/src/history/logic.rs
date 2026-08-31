//! Pure session grouping, filtering, search scope calculation, and date
//! formatting.

use veyyon_gui_core::{
	model::{SessionStatus, SessionSummary, format_size},
	navigation::HistoryGroupBy,
};

/// Calendar day grouping for a session timestamp relative to a reference time.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DayBucket {
	Today,
	Yesterday,
	Dated(String),
}

impl DayBucket {
	pub fn label(&self) -> &str {
		match self {
			Self::Today => "Today",
			Self::Yesterday => "Yesterday",
			Self::Dated(formatted) => formatted.as_str(),
		}
	}

	pub fn key(&self) -> String {
		match self {
			Self::Today => "date:today".to_owned(),
			Self::Yesterday => "date:yesterday".to_owned(),
			Self::Dated(formatted) => format!("date:{formatted}"),
		}
	}
}

/// Convert UTC epoch milliseconds into civil year, month (1-12), and day
/// (1-31).
pub fn epoch_to_ymd(ms: u64) -> (i32, u32, u32) {
	let days = (ms / 86_400_000) as i64;
	let z = days + 719468;
	let era = if z >= 0 { z } else { z - 146096 } / 146097;
	let doe = (z - era * 146097) as u32;
	let yoe = (doe - doe / 1020 + doe / 1461 - doe / 146096) / 365;
	let y = (yoe as i64) + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if m <= 2 { y + 1 } else { y };
	(y as i32, m, d)
}

/// Classify a session timestamp relative to `now_ms`.
pub fn classify_day_bucket(session_ms: u64, now_ms: u64) -> DayBucket {
	let session_day = session_ms / 86_400_000;
	let now_day = now_ms / 86_400_000;

	if session_day >= now_day {
		DayBucket::Today
	} else if session_day + 1 == now_day {
		DayBucket::Yesterday
	} else {
		let (y, m, d) = epoch_to_ymd(session_ms);
		DayBucket::Dated(format!("{y:04}-{m:02}-{d:02}"))
	}
}

/// Extract human-readable repository name from session metadata.
pub fn repository_name(session: &SessionSummary) -> &str {
	if !session.cwd.trim().is_empty() {
		let trimmed = session.cwd.trim_end_matches(['/', '\\']);
		if let Some(pos) = trimmed.rfind(['/', '\\']) {
			let name = &trimmed[pos + 1..];
			if !name.is_empty() {
				return name;
			}
		}
		return trimmed;
	}
	session.workspace.as_str()
}

/// Resolved display title for a session row.
pub fn row_title(session: &SessionSummary) -> &str {
	if let Some(title) = session.title.as_deref().filter(|t| !t.trim().is_empty()) {
		return title;
	}
	if let Some(first_line) = session
		.first_message
		.as_deref()
		.and_then(|m| m.lines().find(|l| !l.trim().is_empty()))
	{
		return first_line;
	}
	if !session.path.is_empty() {
		return session.path.as_str();
	}
	"Untitled conversation"
}

/// How content was searched and what confidence the match carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchScope {
	/// Full searchable message index was evaluated.
	FullMessages,
	/// Only first message and session title were available to search.
	FirstMessageAndTitle,
	/// No searchable message payload was provided by the engine.
	Unsearchable,
}

impl SearchScope {
	pub fn label(self) -> &'static str {
		match self {
			Self::FullMessages => "Full transcript index",
			Self::FirstMessageAndTitle => "Title & first message only",
			Self::Unsearchable => "Unsearchable (no message content)",
		}
	}
}

/// Determine whether a session has searchable content and whether it matches
/// `query`.
pub fn search_session(session: &SessionSummary, query: &str) -> Option<SearchScope> {
	let trimmed = query.trim();
	let has_full = session
		.searchable_messages
		.as_deref()
		.is_some_and(|s| !s.trim().is_empty());
	let has_partial = session
		.first_message
		.as_deref()
		.is_some_and(|s| !s.trim().is_empty())
		|| session
			.title
			.as_deref()
			.is_some_and(|s| !s.trim().is_empty());

	if !has_full && !has_partial {
		// Session has no searchable content at all: always surfaced with Unsearchable
		// status.
		return Some(SearchScope::Unsearchable);
	}

	if trimmed.is_empty() {
		if has_full {
			return Some(SearchScope::FullMessages);
		}
		return Some(SearchScope::FirstMessageAndTitle);
	}

	if has_full {
		let matches = session
			.searchable_messages
			.as_deref()
			.is_some_and(|s| contains_ignore_case(s, trimmed))
			|| session
				.title
				.as_deref()
				.is_some_and(|s| contains_ignore_case(s, trimmed))
			|| contains_ignore_case(repository_name(session), trimmed);
		if matches {
			return Some(SearchScope::FullMessages);
		}
		return None;
	}

	// Partial search across title, first message, and repo
	let matches = session
		.title
		.as_deref()
		.is_some_and(|s| contains_ignore_case(s, trimmed))
		|| session
			.first_message
			.as_deref()
			.is_some_and(|s| contains_ignore_case(s, trimmed))
		|| contains_ignore_case(repository_name(session), trimmed);
	if matches {
		return Some(SearchScope::FirstMessageAndTitle);
	}
	None
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
	if haystack.is_ascii() && needle.is_ascii() {
		let n = needle.as_bytes();
		haystack
			.as_bytes()
			.windows(n.len())
			.any(|w| w.eq_ignore_ascii_case(n))
	} else {
		haystack.to_lowercase().contains(&needle.to_lowercase())
	}
}

/// A rendered item in the history browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRowItem {
	pub id:             veyyon_gui_core::model::SessionId,
	pub title:          String,
	pub repository:     String,
	pub message_count:  u64,
	pub size_bytes:     u64,
	pub formatted_size: String,
	pub search_scope:   SearchScope,
	pub status:         SessionStatus,
	pub modified_at_ms: u64,
	pub created_at_ms:  u64,
	pub path:           String,
	pub cwd:            String,
}

impl HistoryRowItem {
	pub fn from_summary(session: &SessionSummary, search_scope: SearchScope) -> Self {
		Self {
			id: session.id.clone(),
			title: row_title(session).to_owned(),
			repository: repository_name(session).to_owned(),
			message_count: session.message_count,
			size_bytes: session.size_bytes,
			formatted_size: format_size(session.size_bytes),
			search_scope,
			status: session.status,
			modified_at_ms: session.modified_at_ms,
			created_at_ms: session.created_at_ms,
			path: session.path.clone(),
			cwd: session.cwd.clone(),
		}
	}
}

/// A collapsible group of sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryGroup {
	pub key:   String,
	pub label: String,
	pub rows:  Vec<HistoryRowItem>,
}

/// Filter sessions by search query and group them by Date or Repository.
pub fn filter_and_group(
	sessions: &[SessionSummary],
	query: &str,
	group_by: HistoryGroupBy,
	now_ms: u64,
) -> Vec<HistoryGroup> {
	let mut matched_items = Vec::new();
	for session in sessions {
		if let Some(scope) = search_session(session, query) {
			matched_items.push(HistoryRowItem::from_summary(session, scope));
		}
	}

	match group_by {
		HistoryGroupBy::Date => {
			let mut today_rows = Vec::new();
			let mut yesterday_rows = Vec::new();
			let mut dated_map: std::collections::BTreeMap<String, Vec<HistoryRowItem>> =
				std::collections::BTreeMap::new();

			for item in matched_items {
				let bucket = classify_day_bucket(item.modified_at_ms, now_ms);
				match bucket {
					DayBucket::Today => today_rows.push(item),
					DayBucket::Yesterday => yesterday_rows.push(item),
					DayBucket::Dated(d) => dated_map.entry(d).or_default().push(item),
				}
			}

			let mut groups = Vec::new();
			if !today_rows.is_empty() {
				today_rows.sort_by_key(|a| std::cmp::Reverse(a.modified_at_ms));
				groups.push(HistoryGroup {
					key:   "date:today".to_owned(),
					label: "Today".to_owned(),
					rows:  today_rows,
				});
			}
			if !yesterday_rows.is_empty() {
				yesterday_rows.sort_by_key(|a| std::cmp::Reverse(a.modified_at_ms));
				groups.push(HistoryGroup {
					key:   "date:yesterday".to_owned(),
					label: "Yesterday".to_owned(),
					rows:  yesterday_rows,
				});
			}
			for (date_str, mut rows) in dated_map.into_iter().rev() {
				rows.sort_by_key(|a| std::cmp::Reverse(a.modified_at_ms));
				groups.push(HistoryGroup { key: format!("date:{date_str}"), label: date_str, rows });
			}
			groups
		},
		HistoryGroupBy::Repository => {
			let mut repo_map: std::collections::BTreeMap<String, Vec<HistoryRowItem>> =
				std::collections::BTreeMap::new();
			for item in matched_items {
				repo_map
					.entry(item.repository.clone())
					.or_default()
					.push(item);
			}

			let mut groups = Vec::new();
			for (repo, mut rows) in repo_map {
				rows.sort_by_key(|a| std::cmp::Reverse(a.modified_at_ms));
				groups.push(HistoryGroup { key: format!("repo:{repo}"), label: repo, rows });
			}
			groups
		},
	}
}

#[cfg(test)]
mod tests {
	use veyyon_gui_core::model::{SessionId, WorkspaceId};

	use super::*;

	fn test_summary(id: &str, title: Option<&str>, repo: &str, modified_ms: u64) -> SessionSummary {
		SessionSummary {
			id:                  SessionId::new(id).unwrap(),
			workspace:           WorkspaceId::new("ws").unwrap(),
			path:                format!("/workspaces/{repo}/{id}.jsonl"),
			cwd:                 format!("/workspaces/{repo}"),
			title:               title.map(|t| t.to_owned()),
			parent_path:         None,
			created_at_ms:       modified_ms.saturating_sub(1000),
			modified_at_ms:      modified_ms,
			message_count:       10,
			size_bytes:          4096,
			first_message:       Some("Initial query".to_owned()),
			searchable_messages: Some("Detailed discussion about architecture".to_owned()),
			status:              SessionStatus::Complete,
		}
	}

	#[test]
	fn test_day_bucket_classification() {
		let now = 1756598400000; // Reference epoch ms
		assert_eq!(classify_day_bucket(now, now), DayBucket::Today);
		assert_eq!(classify_day_bucket(now - 86_400_000, now), DayBucket::Yesterday);
		let older = classify_day_bucket(now - 2 * 86_400_000, now);
		assert!(matches!(older, DayBucket::Dated(_)));
	}

	#[test]
	fn test_search_scope_detection() {
		let mut full = test_summary("s1", Some("Title"), "repo", 1000);
		assert_eq!(search_session(&full, "architecture"), Some(SearchScope::FullMessages));

		full.searchable_messages = None;
		assert_eq!(search_session(&full, "Initial"), Some(SearchScope::FirstMessageAndTitle));

		full.first_message = None;
		full.title = None;
		assert_eq!(search_session(&full, "anything"), Some(SearchScope::Unsearchable));
	}
}
