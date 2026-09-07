//! WHY: Image bytes and file metadata were discarded when entries became turns.
//! Sweep all protocol roles and every combination of optional file metadata.
//! This tests production projection and search; decoded pixels and disclosure
//! interactions are covered by the surface renderer suites, not this suite.

mod support;

use std::{collections::HashMap, sync::Arc};

use support::{NOW_MS, entry};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{BlockKind, ContentBlock, MessageRole, SessionId, Store};
use veyyon_desktop_surface::{
	Artifact, Block, ShellState, Turn,
	transcript::{TranscriptFindState, TranscriptViewportState},
};
use veyyon_desktop_tokens::load_bundled_tokens;

fn projected(role: MessageRole, content: Vec<ContentBlock>) -> ShellState {
	let mut store = Store::new();
	let session = SessionId::from("s");
	store.persisted.shell.active_session = Some(session.clone());
	store
		.transcripts
		.entry(session)
		.or_default()
		.append(entry("record", None, role, content));
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
}

#[test]
fn file_metadata_and_images_survive_every_role_and_optional_field_combination() {
	let motion = load_bundled_tokens().expect("bundled tokens").motion.into();
	for role in MessageRole::ALL {
		for bits in 0..32 {
			let has_content = bits & 1 != 0;
			let lines = (bits & 2 != 0).then_some(12);
			let bytes = (bits & 4 != 0).then_some(320);
			let reason = (bits & 8 != 0).then(|| "Permission denied".to_string());
			let image = (bits & 16 != 0).then(|| vec![1u8, 2, 3]);
			let expected = Artifact::File {
				path: "src/recorded.rs".into(),
				has_content,
				lines,
				bytes,
				unavailable_reason: reason.clone(),
				image: image.as_ref().map(|data| Arc::from(data.as_slice())),
			};
			let state = projected(role, vec![ContentBlock::FileMention {
				path: "src/recorded.rs".into(),
				has_content,
				lines,
				bytes,
				unavailable_reason: reason,
				image,
			}]);
			if role == MessageRole::User {
				assert_eq!(state.transcript, vec![Turn::OperatorArtifacts {
					text:      String::new(),
					artifacts: vec![expected],
				}]);
			} else {
				assert_eq!(
					state.transcript,
					vec![Turn::Agent { blocks: vec![Block::Artifact(expected)], model: None }],
					"{role:?}, {bits}"
				);
			}
			let viewport = TranscriptViewportState::new();
			viewport.sync_turns(&state.transcript, false);
			let mut find = TranscriptFindState::new();
			find.set_query_and_reveal(
				"RECORDED.RS",
				&state.transcript,
				&viewport,
				&motion,
				true,
				std::time::Instant::now(),
			);
			assert_eq!(find.match_count(), 1);
			assert!(viewport.is_block_expanded(0, 0), "{role:?}: matched artifact must open");
		}
	}
}

#[test]
fn image_payload_and_alt_survive_in_user_and_agent_turns() {
	for role in MessageRole::ALL {
		let expected = Artifact::Image {
			media_type: "image/png".into(),
			data:       Arc::from([1u8, 2, 3]),
			alt:        Some("Diagram".into()),
		};
		let state = projected(role, vec![ContentBlock::Image {
			media_type: "image/png".into(),
			data:       vec![1, 2, 3],
			alt:        Some("Diagram".into()),
		}]);
		if role == MessageRole::User {
			assert_eq!(state.transcript, vec![Turn::OperatorArtifacts {
				text:      String::new(),
				artifacts: vec![expected],
			}]);
		} else {
			assert_eq!(state.transcript, vec![Turn::Agent {
				blocks: vec![Block::Artifact(expected)],
				model:  None,
			}]);
		}
	}
}

#[test]
fn user_text_segments_preserve_empty_lines_around_attachments() {
	let state = projected(MessageRole::User, vec![
		ContentBlock::Text { text: String::new() },
		ContentBlock::Image { media_type: "image/png".into(), data: vec![1], alt: None },
		ContentBlock::Text { text: "Caption".into() },
		ContentBlock::Text { text: String::new() },
	]);
	assert!(matches!(state.transcript.as_slice(), [Turn::OperatorArtifacts { text, artifacts }]
		if text == "\nCaption\n" && artifacts.len() == 1));
}

#[test]
fn unknown_records_preserve_raw_values_for_disclosure_and_search() {
	for kind in [BlockKind::Fallback, BlockKind::Unknown] {
		for value in [
			serde_json::Value::Null,
			serde_json::json!({"recorded": [1, true, "needle"]}),
			serde_json::json!("line one\nline two"),
		] {
			let (content, producer) = match kind {
				BlockKind::Fallback => (
					ContentBlock::Fallback { producer: "extension".into(), value: value.clone() },
					"Fallback: extension",
				),
				BlockKind::Unknown => (
					ContentBlock::Unknown { tag: "future".into(), value: value.clone() },
					"Unknown: future",
				),
				_ => unreachable!(),
			};
			let state = projected(MessageRole::Unknown, vec![content]);
			assert_eq!(state.transcript, vec![Turn::Agent {
				blocks: vec![Block::Unknown {
					producer: producer.into(),
					lines:    vec![value.to_string()],
				}],
				model:  None,
			}]);
			let mut search = TranscriptFindState::new();
			search.set_query(&value.to_string(), &state.transcript);
			assert_eq!(search.match_count(), 1, "{kind:?}: raw payload remains searchable");
		}
	}
}
