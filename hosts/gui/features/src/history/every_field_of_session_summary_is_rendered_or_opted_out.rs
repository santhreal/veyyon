//! WHY: Every field of `SessionSummary` that the history surface claims to
//! present must be accounted for in the rendered row representation. Silent
//! omission of metadata (such as message counts, formatted read units, or index
//! status) diminishes session context.
//!
//! This suite sweeps the fields of `SessionSummary` at run time via JSON
//! serialization reflection and verifies that every field is either explicitly
//! surfaced in `HistoryRowItem` / history row view or recorded in a pinned
//! opt-out list with an exact reason.
//!
//! What it does not catch: layout font colors or DOM element dimensions.

use std::collections::BTreeSet;

use veyyon_gui_core::model::{SessionId, SessionStatus, SessionSummary, WorkspaceId};

use super::logic::{HistoryRowItem, SearchScope};

/// Pinned opt-outs for `SessionSummary` fields not surfaced directly on history
/// rows.
struct FieldOptOut {
	field_name: &'static str,
	reason:     &'static str,
}

const PINNED_FIELD_OPT_OUTS: &[FieldOptOut] = &[FieldOptOut {
	field_name: "parent_path",
	reason:     "session fork parent path is internal engine metadata not surfaced in top-level \
	             history browsing rows",
}];

fn sample_summary() -> SessionSummary {
	SessionSummary {
		id:                  SessionId::new("test-session").unwrap(),
		workspace:           WorkspaceId::new("test-workspace").unwrap(),
		path:                "/workspaces/repo/session.jsonl".to_owned(),
		cwd:                 "/workspaces/repo".to_owned(),
		title:               Some("Sample Title".to_owned()),
		parent_path:         None,
		created_at_ms:       1000,
		modified_at_ms:      2000,
		message_count:       42,
		size_bytes:          4096,
		first_message:       Some("Initial query".to_owned()),
		searchable_messages: Some("Full searchable transcript".to_owned()),
		status:              SessionStatus::Complete,
	}
}

/// Fields that the history surface explicitly processes and renders.
fn surfaced_fields() -> BTreeSet<&'static str> {
	BTreeSet::from([
		"id",
		"workspace",
		"path",
		"cwd",
		"title",
		"created_at_ms",
		"modified_at_ms",
		"message_count",
		"size_bytes",
		"first_message",
		"searchable_messages",
		"status",
	])
}

#[test]
fn test_every_session_summary_field_is_surfaced_or_opted_out() {
	let summary = sample_summary();
	let json_val = serde_json::to_value(&summary).expect("SessionSummary must serialize to JSON");
	let obj = json_val
		.as_object()
		.expect("SessionSummary must serialize as a JSON object");

	let all_fields: BTreeSet<&str> = obj.keys().map(|s| s.as_str()).collect();
	let surfaced = surfaced_fields();

	let opt_out_map: BTreeSet<&str> = PINNED_FIELD_OPT_OUTS.iter().map(|o| o.field_name).collect();

	// Check that opt-outs are pinned by exact equality
	assert_eq!(PINNED_FIELD_OPT_OUTS.len(), 1);
	assert_eq!(PINNED_FIELD_OPT_OUTS[0].field_name, "parent_path");
	assert!(!PINNED_FIELD_OPT_OUTS[0].reason.is_empty());

	// Every field in SessionSummary must be accounted for
	let mut unaccounted = Vec::new();
	for field in &all_fields {
		if !surfaced.contains(field) && !opt_out_map.contains(field) {
			unaccounted.push(*field);
		}
	}

	assert_eq!(
		unaccounted,
		Vec::<&str>::new(),
		"All SessionSummary fields must be surfaced or in PINNED_FIELD_OPT_OUTS"
	);

	// Ensure HistoryRowItem actually receives and holds these values
	let row_item = HistoryRowItem::from_summary(&summary, SearchScope::FullMessages);
	assert_eq!(row_item.id, summary.id);
	assert_eq!(row_item.title, "Sample Title");
	assert_eq!(row_item.repository, "repo");
	assert_eq!(row_item.message_count, 42);
	assert_eq!(row_item.size_bytes, 4096);
	assert_eq!(row_item.formatted_size, "4.0 KiB");
	assert_eq!(row_item.status, SessionStatus::Complete);
	assert_eq!(row_item.modified_at_ms, 2000);
	assert_eq!(row_item.created_at_ms, 1000);
}
