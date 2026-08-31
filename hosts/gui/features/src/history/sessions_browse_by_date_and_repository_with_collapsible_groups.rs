//! WHY: Sessions before this feature were flat and only accessible if loaded
//! into the active conversation shelf. Browsing past sessions requires grouping
//! both by temporal recency (Today, Yesterday, Dated) and by workspace
//! repository, with individual collapsible group sections so large indexes
//! remain navigable.
//!
//! This suite closes the class of missing, malformed, or uncollapsible session
//! history groupings by asserting that sessions across multiple days and
//! multiple repositories are correctly partitioned, sorted, and collapsible,
//! even when sessions lack titles or first messages.
//!
//! What it does not catch: OS-level font metrics and GPU rasterization.

use veyyon_gui_core::{
	Store, UiCommand,
	model::{RemoteData, SessionId, SessionStatus, SessionSummary, Versioned, WorkspaceId},
	navigation::{HistoryGroupBy, Route},
};

use super::logic::filter_and_group;

fn sample_sessions(now_ms: u64) -> Vec<SessionSummary> {
	let day_ms = 86_400_000;
	vec![
		SessionSummary {
			id:                  SessionId::new("s-today-1").unwrap(),
			workspace:           WorkspaceId::new("ws-alpha").unwrap(),
			path:                "/repos/alpha/s1.jsonl".to_owned(),
			cwd:                 "/repos/alpha".to_owned(),
			title:               Some("Today Alpha Session".to_owned()),
			parent_path:         None,
			created_at_ms:       now_ms - 1000,
			modified_at_ms:      now_ms - 500,
			message_count:       8,
			size_bytes:          2048,
			first_message:       Some("Fix auth bug".to_owned()),
			searchable_messages: Some("Fix auth bug in login handler".to_owned()),
			status:              SessionStatus::Complete,
		},
		SessionSummary {
			id:                  SessionId::new("s-today-2-no-title").unwrap(),
			workspace:           WorkspaceId::new("ws-beta").unwrap(),
			path:                "/repos/beta/s2.jsonl".to_owned(),
			cwd:                 "/repos/beta".to_owned(),
			title:               None,
			parent_path:         None,
			created_at_ms:       now_ms - 2000,
			modified_at_ms:      now_ms - 1500,
			message_count:       3,
			size_bytes:          1024,
			first_message:       Some("Refactor database schema".to_owned()),
			searchable_messages: Some("Database migration details".to_owned()),
			status:              SessionStatus::Pending,
		},
		SessionSummary {
			id:                  SessionId::new("s-yesterday-1-no-first-msg").unwrap(),
			workspace:           WorkspaceId::new("ws-alpha").unwrap(),
			path:                "/repos/alpha/s3.jsonl".to_owned(),
			cwd:                 "/repos/alpha".to_owned(),
			title:               Some("Yesterday Alpha Without First Msg".to_owned()),
			parent_path:         None,
			created_at_ms:       now_ms - day_ms - 5000,
			modified_at_ms:      now_ms - day_ms - 1000,
			message_count:       14,
			size_bytes:          4096,
			first_message:       None,
			searchable_messages: Some("Full transcript from yesterday".to_owned()),
			status:              SessionStatus::Complete,
		},
		SessionSummary {
			id:                  SessionId::new("s-dated-old").unwrap(),
			workspace:           WorkspaceId::new("ws-beta").unwrap(),
			path:                "/repos/beta/s4.jsonl".to_owned(),
			cwd:                 "/repos/beta".to_owned(),
			title:               Some("Old Beta Session".to_owned()),
			parent_path:         None,
			created_at_ms:       now_ms - 5 * day_ms - 10000,
			modified_at_ms:      now_ms - 5 * day_ms - 5000,
			message_count:       22,
			size_bytes:          8192,
			first_message:       Some("Old work".to_owned()),
			searchable_messages: None,
			status:              SessionStatus::Interrupted,
		},
	]
}

#[test]
fn test_sessions_grouping_by_date_and_repository() {
	let now_ms = 1756598400000 + 36_000_000;
	let sessions = sample_sessions(now_ms);

	// 1. Group by Date
	let date_groups = filter_and_group(&sessions, "", HistoryGroupBy::Date, now_ms);
	assert_eq!(date_groups.len(), 3, "should have Today, Yesterday, and Dated groups");

	assert_eq!(date_groups[0].label, "Today");
	assert_eq!(date_groups[0].rows.len(), 2);
	// Check session with no title uses first_message fallback
	let no_title_item = date_groups[0]
		.rows
		.iter()
		.find(|r| r.id.as_str() == "s-today-2-no-title")
		.unwrap();
	assert_eq!(no_title_item.title, "Refactor database schema");
	assert_eq!(no_title_item.repository, "beta");

	assert_eq!(date_groups[1].label, "Yesterday");
	assert_eq!(date_groups[1].rows.len(), 1);
	assert_eq!(date_groups[1].rows[0].id.as_str(), "s-yesterday-1-no-first-msg");
	assert_eq!(date_groups[1].rows[0].title, "Yesterday Alpha Without First Msg");

	assert!(date_groups[2].label.contains("-"));
	assert_eq!(date_groups[2].rows.len(), 1);
	assert_eq!(date_groups[2].rows[0].id.as_str(), "s-dated-old");

	// 2. Group by Repository
	let repo_groups = filter_and_group(&sessions, "", HistoryGroupBy::Repository, now_ms);
	assert_eq!(repo_groups.len(), 2, "should have alpha and beta repo groups");

	let alpha_group = repo_groups.iter().find(|g| g.label == "alpha").unwrap();
	assert_eq!(alpha_group.rows.len(), 2);

	let beta_group = repo_groups.iter().find(|g| g.label == "beta").unwrap();
	assert_eq!(beta_group.rows.len(), 2);
}

#[test]
fn test_collapsible_groups_in_store() {
	let now_ms = 1756598400000 + 36_000_000;
	let mut store = Store::detached();
	store.frontend.route = Route::History;
	store.replica.sessions.sessions =
		RemoteData::Ready(Versioned { revision: 1, value: sample_sessions(now_ms) });

	assert!(!store.frontend.history.is_collapsed("date:today"));

	// Toggle collapse today
	store.dispatch(UiCommand::ToggleHistoryGroup("date:today".to_owned()));
	assert!(store.frontend.history.is_collapsed("date:today"));

	// Toggle collapse back
	store.dispatch(UiCommand::ToggleHistoryGroup("date:today".to_owned()));
	assert!(!store.frontend.history.is_collapsed("date:today"));

	// Switch grouping mode to Repository
	store.dispatch(UiCommand::SetHistoryGroupBy(HistoryGroupBy::Repository));
	assert_eq!(store.frontend.history.group_by, HistoryGroupBy::Repository);

	// Collapse repo:alpha
	store.dispatch(UiCommand::ToggleHistoryGroup("repo:alpha".to_owned()));
	assert!(store.frontend.history.is_collapsed("repo:alpha"));

	// Expand all
	store.dispatch(UiCommand::ExpandAllHistoryGroups);
	assert!(!store.frontend.history.is_collapsed("repo:alpha"));
	assert!(!store.frontend.history.is_collapsed("date:today"));
}
