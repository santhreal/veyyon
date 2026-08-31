//! WHY: Searching past conversations must be transparent about index coverage.
//! If a user searches for a term, returning only partial results without
//! indicating whether the entire transcript was indexed or merely the first
//! message/title leads to false negative conclusions. Moreover, sessions for
//! which the engine has not yet sent searchable message metadata must be
//! explicitly surfaced as unsearchable rather than silently dropped from the
//! listing.
//!
//! This suite closes the class of deceptive search filtering and silent index
//! exclusion by asserting that full transcript matches, partial header matches,
//! and unsearchable sessions are accurately distinguished and never dropped.
//!
//! What it does not catch: fuzzy phonetic matching and non-Latin character
//! normalization.

use veyyon_gui_core::model::{SessionId, SessionStatus, SessionSummary, WorkspaceId};

use super::logic::{SearchScope, filter_and_group};

fn create_session(
	id: &str,
	title: Option<&str>,
	first_msg: Option<&str>,
	searchable_msgs: Option<&str>,
) -> SessionSummary {
	SessionSummary {
		id:                  SessionId::new(id).unwrap(),
		workspace:           WorkspaceId::new("ws").unwrap(),
		path:                format!("/workspaces/{id}.jsonl"),
		cwd:                 "/workspaces/my-repo".to_owned(),
		title:               title.map(|t| t.to_owned()),
		parent_path:         None,
		created_at_ms:       1000,
		modified_at_ms:      2000,
		message_count:       5,
		size_bytes:          1024,
		first_message:       first_msg.map(|m| m.to_owned()),
		searchable_messages: searchable_msgs.map(|m| m.to_owned()),
		status:              SessionStatus::Complete,
	}
}

#[test]
fn test_search_scope_distinction_and_unsearchable_inclusion() {
	let full_session = create_session(
		"s-full",
		Some("Compiler Performance"),
		Some("How to optimize LLVM?"),
		Some("Detailed benchmarks showing 45% speedup in codegen phase"),
	);

	let partial_session = create_session(
		"s-partial",
		Some("Database Migration"),
		Some("Run alter table on users"),
		None,
	);

	let unsearchable_session = create_session("s-unsearchable", None, None, None);

	let sessions = vec![full_session, partial_session, unsearchable_session];

	// 1. Search term present only in full transcript
	let result_codegen = filter_and_group(
		&sessions,
		"codegen",
		veyyon_gui_core::navigation::HistoryGroupBy::Date,
		2000,
	);
	assert_eq!(result_codegen.len(), 1);
	assert_eq!(
		result_codegen[0].rows.len(),
		2,
		"full match + unsearchable session must both be returned"
	);
	let full_row = result_codegen[0]
		.rows
		.iter()
		.find(|r| r.id.as_str() == "s-full")
		.unwrap();
	assert_eq!(full_row.search_scope, SearchScope::FullMessages);
	let unsearchable_row = result_codegen[0]
		.rows
		.iter()
		.find(|r| r.id.as_str() == "s-unsearchable")
		.unwrap();
	assert_eq!(unsearchable_row.search_scope, SearchScope::Unsearchable);

	// 2. Search term present in title / first_message of partial session
	let result_table = filter_and_group(
		&sessions,
		"alter table",
		veyyon_gui_core::navigation::HistoryGroupBy::Date,
		2000,
	);
	assert_eq!(result_table.len(), 1);
	assert_eq!(result_table[0].rows.len(), 2, "partial match + unsearchable session");
	let partial_row = result_table[0]
		.rows
		.iter()
		.find(|r| r.id.as_str() == "s-partial")
		.unwrap();
	assert_eq!(partial_row.search_scope, SearchScope::FirstMessageAndTitle);

	// 3. Search term matching nothing in searchable sessions still retains the
	//    unsearchable session
	let result_nomatch = filter_and_group(
		&sessions,
		"xyznonexistent",
		veyyon_gui_core::navigation::HistoryGroupBy::Date,
		2000,
	);
	assert_eq!(result_nomatch.len(), 1);
	assert_eq!(result_nomatch[0].rows.len(), 1);
	assert_eq!(result_nomatch[0].rows[0].id.as_str(), "s-unsearchable");
	assert_eq!(result_nomatch[0].rows[0].search_scope, SearchScope::Unsearchable);
}
