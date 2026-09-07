//! WHY: Host tool result IDs were compared with display names, leaving calls
//! running and mis-associating repeated tools. Error markers and omitted-line
//! counts must survive both matched and unmatched results. These tests exercise
//! production projection; host message conversion and native clicks are
//! separate.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, agent_blocks, entry};
use veyyon_desktop::{PANE_LINE_CEILING, SessionIndex, project};
use veyyon_desktop_model::{ContentBlock, MessageRole, SessionId, Store};
use veyyon_desktop_surface::{Block, ShellState};

#[test]
fn repeated_tools_correlate_by_call_identity_in_either_completion_order() {
	for reverse in [false, true] {
		for failed in [false, true] {
			let mut store = Store::new();
			store.persisted.shell.active_session = Some(SessionId::from("s"));
			let tree = store.transcripts.entry(SessionId::from("s")).or_default();
			tree.append(entry(
				"calls",
				None,
				MessageRole::Assistant,
				["first", "second"]
					.map(|id| ContentBlock::ToolCall {
						id:        id.into(),
						name:      "read".into(),
						arguments: serde_json::json!({ "path": id }),
					})
					.to_vec(),
			));
			let order = if reverse {
				["second", "first"]
			} else {
				["first", "second"]
			};
			let mut parent = "calls";
			for id in order {
				tree.append(entry(id, Some(parent), MessageRole::ToolResult, vec![
					ContentBlock::ToolResult {
						tool:     id.into(),
						content:  serde_json::json!(format!("output {id}")),
						is_error: failed,
					},
				]));
				parent = id;
			}
			tree.append(entry("orphan", Some(parent), MessageRole::ToolResult, vec![
				ContentBlock::ToolResult {
					tool:     "read".into(),
					content:  serde_json::json!("unmatched"),
					is_error: failed,
				},
			]));
			let mut state = ShellState::default();
			project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
			let blocks = agent_blocks(&state.transcript[0]);
			assert_eq!(blocks.len(), 3);
			for (ix, id) in ["first", "second"].into_iter().enumerate() {
				let expected = format!("{}output {id}", if failed { "error: " } else { "" });
				assert!(matches!(&blocks[ix], Block::Invoke { target, result, .. }
					if target == id && result.as_deref() == Some(expected.as_str())));
			}
			let orphan_text = if failed {
				"error: unmatched"
			} else {
				"unmatched"
			};
			assert!(matches!(&blocks[2], Block::Pane { caption, lines }
				if caption == "read" && lines == &[orphan_text]));
		}
	}
}

#[test]
fn tool_results_are_truncated_once_with_errors_and_remaining_counts_intact() {
	for matched in [false, true] {
		for failed in [false, true] {
			for count in [0, PANE_LINE_CEILING, PANE_LINE_CEILING + 7] {
				let mut store = Store::new();
				store.persisted.shell.active_session = Some(SessionId::from("s"));
				let mut content = Vec::new();
				if matched {
					content.push(ContentBlock::ToolCall {
						id:        "call".into(),
						name:      "read".into(),
						arguments: serde_json::json!({}),
					});
				}
				let output = (0..count)
					.map(|i| format!("line {i}"))
					.collect::<Vec<_>>()
					.join("\n");
				content.push(ContentBlock::ToolResult {
					tool:     "call".into(),
					content:  serde_json::json!(output),
					is_error: failed,
				});
				store
					.transcripts
					.entry(SessionId::from("s"))
					.or_default()
					.append(entry("result", None, MessageRole::ToolResult, content));
				let mut state = ShellState::default();
				project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
				let text = match &agent_blocks(&state.transcript[0])[0] {
					Block::Invoke { result: Some(result), .. } => result.clone(),
					Block::Pane { lines, .. } => lines.join("\n"),
					other => panic!("unexpected result block {other:?}"),
				};
				let mut expected = (0..count.min(PANE_LINE_CEILING))
					.map(|i| format!("line {i}"))
					.collect::<Vec<_>>()
					.join("\n");
				if count > PANE_LINE_CEILING {
					expected.push_str("\n… 7 more lines");
				}
				if failed {
					expected.insert_str(0, "error: ");
				}
				assert_eq!(text, expected, "matched={matched} failed={failed} count={count}");
			}
		}
	}
}
