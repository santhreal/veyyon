//! WHY: Non-assistant records previously rendered as unlabeled assistant prose.
//! Sweep every protocol role through production projection, asserting labels
//! and structural boundaries. Pixel hierarchy is covered by the scene
//! catalogue; this suite does not exercise socket transport.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, entry};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{ContentBlock, MessageRole, SessionId, Store};
use veyyon_desktop_surface::{Block, ShellState, Turn, transcript::find::TranscriptFindState};

#[test]
fn every_role_preserves_text_in_its_display_register() {
	for role in MessageRole::ALL {
		let expected = match role {
			MessageRole::User | MessageRole::Assistant => None,
			MessageRole::Developer => Some(("Developer", false)),
			MessageRole::Custom => Some(("Custom", false)),
			MessageRole::ToolResult => Some(("Tool result", false)),
			MessageRole::BashExecution => Some(("Shell execution", false)),
			MessageRole::PythonExecution => Some(("Python execution", false)),
			MessageRole::BranchSummary => Some(("Branch summary", true)),
			MessageRole::CompactionSummary => Some(("Compaction summary", true)),
			MessageRole::FileMention => Some(("File", false)),
			MessageRole::Lifecycle => Some(("Lifecycle", false)),
			MessageRole::Unknown => Some(("Unknown", false)),
		};
		let mut store = Store::new();
		let session = SessionId::from("s");
		store.persisted.shell.active_session = Some(session.clone());
		store
			.transcripts
			.entry(session)
			.or_default()
			.append(entry("record", None, role, vec![ContentBlock::Text {
				text: "Recorded text".into(),
			}]));
		let mut state = ShellState::default();
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
		match expected {
			Some((expected_label, expected_boundary)) => {
				assert!(
					matches!(state.transcript.as_slice(), [Turn::Agent(blocks)]
					if matches!(blocks.as_slice(), [Block::Note { label, text, boundary }]
						if *label == expected_label && text == "Recorded text" && *boundary == expected_boundary)),
					"{role:?}: {:?}",
					state.transcript
				);
				let mut search = TranscriptFindState::new();
				for query in [expected_label.to_uppercase(), "RECORDED TEXT".to_string()] {
					search.set_query(&query, &state.transcript);
					assert_eq!(search.matches.len(), 1, "{role:?}: {query}");
					assert_eq!(search.matches[0].snippet, format!("{expected_label}: Recorded text"));
				}
				search.set_query("missing content", &state.transcript);
				assert!(search.matches.is_empty());
			},
			None if role == MessageRole::User => assert!(matches!(state.transcript.as_slice(),
				[Turn::Operator(text)] if text == "Recorded text")),
			None => assert!(matches!(state.transcript.as_slice(), [Turn::Agent(blocks)]
				if matches!(blocks.as_slice(), [Block::Prose(text)] if text == "Recorded text"))),
		}
	}
}

#[test]
fn execution_and_summary_records_distinguish_their_protocol_roles() {
	for role in MessageRole::ALL {
		let (content, expected) = match role {
			MessageRole::BashExecution | MessageRole::PythonExecution => {
				let label = if role == MessageRole::BashExecution {
					"Shell"
				} else {
					"Python"
				};
				(
					ContentBlock::Execution {
						language:  "shared".into(),
						command:   Some("run".into()),
						output:    "result".into(),
						exit_code: Some(2),
					},
					Block::Pane {
						caption: format!("{label}: run · exit 2"),
						lines:   vec!["result".into()],
					},
				)
			},
			MessageRole::BranchSummary | MessageRole::CompactionSummary => {
				let label = if role == MessageRole::BranchSummary {
					"Branch summary"
				} else {
					"Compaction summary"
				};
				(
					ContentBlock::Summary { kind: "context".into(), text: "recorded".into() },
					Block::Note { label, text: "context: recorded".into(), boundary: true },
				)
			},
			MessageRole::User
			| MessageRole::Assistant
			| MessageRole::Developer
			| MessageRole::Custom
			| MessageRole::ToolResult
			| MessageRole::FileMention
			| MessageRole::Lifecycle
			| MessageRole::Unknown => continue,
		};
		let mut store = Store::new();
		let session = SessionId::from("s");
		store.persisted.shell.active_session = Some(session.clone());
		store
			.transcripts
			.entry(session)
			.or_default()
			.append(entry("record", None, role, vec![content]));
		let mut state = ShellState::default();
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
		assert_eq!(state.transcript, vec![Turn::Agent(vec![expected])], "{role:?}");
	}
}
