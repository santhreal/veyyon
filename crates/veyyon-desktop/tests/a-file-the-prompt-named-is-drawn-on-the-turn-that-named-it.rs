//! WHY: an `@path` mention is recorded as its own transcript entry directly
//! after the prompt that wrote it, carrying the files that were read rather
//! than any text. The projection had no case for `MessageRole::FileMention`,
//! so the entry fell through to the agent branch: a file the operator's own
//! prompt named was drawn as model output, above prose the model had not
//! produced yet, and a mention that arrived before any turn opened an agent
//! turn with nothing in it but somebody else's attachment.
//!
//! CLASS CLOSED: a role whose content is attributed to the wrong speaker.
//! `MessageRole::ALL` is swept at run time and the roles that draw on an
//! operator turn are pinned by exact equality against the roles that open an
//! agent turn, so a role added to the model turns this red until the
//! projection states which speaker owns it. Also covered: a mention joining a
//! prompt that already carried attachments, a mention with no prompt in front
//! of it, and the metadata each file state hands the renderer.
//!
//! NOT CAUGHT: how an artifact block draws once it is on the turn, which is
//! the surface crate's `artifact` suites; and whether the host records the
//! mention at all, which is
//! `packages/coding-agent/test/gui-host/a-file-a-prompt-read-is-stated-to-the-desktop.test.ts`.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, entry};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{ContentBlock, MessageRole, SessionId, Store};
use veyyon_desktop_surface::{Artifact, ShellState, Turn};

fn mention(path: &str) -> ContentBlock {
	ContentBlock::FileMention {
		path:               path.to_string(),
		has_content:        true,
		lines:              Some(12),
		bytes:              Some(480),
		unavailable_reason: None,
		image:              None,
	}
}

fn seeded(entries: Vec<(&str, Option<&str>, MessageRole, Vec<ContentBlock>)>) -> ShellState {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	for (id, parent, role, content) in entries {
		tree.append(entry(id, parent, role, content));
	}
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
}

fn artifacts(turn: &Turn) -> &[Artifact] {
	match turn {
		Turn::OperatorArtifacts { artifacts, .. } => artifacts,
		other => panic!("expected the operator's turn to hold artifacts, got {other:?}"),
	}
}

#[test]
fn a_file_the_prompt_named_joins_the_turn_that_named_it() {
	let state = seeded(vec![
		("u1", None, MessageRole::User, vec![ContentBlock::Text {
			text: "explain @README.md".to_string(),
		}]),
		("m1", Some("u1"), MessageRole::FileMention, vec![mention("README.md")]),
	]);

	assert_eq!(state.transcript.len(), 1, "the mention draws no turn of its own: {:?}", state.transcript);
	let Turn::OperatorArtifacts { text, artifacts } = &state.transcript[0] else {
		panic!("expected one operator turn holding the file, got {:?}", state.transcript);
	};
	assert_eq!(text, "explain @README.md", "the prompt's own words survive the join");
	assert!(
		matches!(&artifacts[..], [Artifact::File { path, has_content, lines, bytes, .. }]
			if path == "README.md" && *has_content && *lines == Some(12) && *bytes == Some(480)),
		"the file arrives with what the host measured: {artifacts:?}"
	);
}

#[test]
fn a_mention_adds_to_what_the_prompt_already_carried() {
	let state = seeded(vec![
		("u1", None, MessageRole::User, vec![
			ContentBlock::Text { text: "compare these".to_string() },
			ContentBlock::Image {
				media_type: "image/png".to_string(),
				data:       vec![1, 2, 3],
				alt:        None,
			},
		]),
		("m1", Some("u1"), MessageRole::FileMention, vec![mention("a.rs"), mention("b.rs")]),
	]);

	assert_eq!(state.transcript.len(), 1, "still one turn: {:?}", state.transcript);
	let held = artifacts(&state.transcript[0]);
	assert!(
		matches!(held, [Artifact::Image { .. }, Artifact::File { path: a, .. }, Artifact::File { path: b, .. }]
			if a == "a.rs" && b == "b.rs"),
		"the pasted image keeps its place ahead of the files the prompt read: {held:?}"
	);
}

#[test]
fn a_second_mention_entry_lands_on_the_same_turn() {
	let state = seeded(vec![
		("u1", None, MessageRole::User, vec![ContentBlock::Text { text: "both".to_string() }]),
		("m1", Some("u1"), MessageRole::FileMention, vec![mention("a.rs")]),
		("m2", Some("m1"), MessageRole::FileMention, vec![mention("b.rs")]),
	]);

	assert_eq!(state.transcript.len(), 1, "one prompt, one turn: {:?}", state.transcript);
	assert_eq!(artifacts(&state.transcript[0]).len(), 2, "both entries' files are held");
}

#[test]
fn a_mention_with_no_prompt_in_front_of_it_is_still_the_operators() {
	let state = seeded(vec![(
		"m1",
		None,
		MessageRole::FileMention,
		vec![mention("README.md")],
	)]);

	assert_eq!(state.transcript.len(), 1, "the file is drawn: {:?}", state.transcript);
	let Turn::OperatorArtifacts { text, artifacts } = &state.transcript[0] else {
		panic!("a replayed mention opened a turn nobody spoke in: {:?}", state.transcript);
	};
	assert!(text.is_empty(), "no words are invented for a prompt that was not replayed");
	assert_eq!(artifacts.len(), 1, "the file is what the turn holds");
}

#[test]
fn a_mention_that_read_nothing_draws_nothing() {
	let state = seeded(vec![
		("u1", None, MessageRole::User, vec![ContentBlock::Text { text: "hello".to_string() }]),
		("m1", Some("u1"), MessageRole::FileMention, vec![ContentBlock::Text {
			text: "ignored".to_string(),
		}]),
	]);

	assert!(
		matches!(state.transcript.as_slice(), [Turn::Operator(text)] if text == "hello"),
		"a mention entry carrying no file leaves the prompt as it was: {:?}",
		state.transcript
	);
}

#[test]
fn every_reason_a_body_is_missing_reaches_the_renderer() {
	for reason in ["too large to read", "binary file", "content not replicated"] {
		let state = seeded(vec![
			("u1", None, MessageRole::User, vec![ContentBlock::Text { text: "look".to_string() }]),
			("m1", Some("u1"), MessageRole::FileMention, vec![ContentBlock::FileMention {
				path:               "big.bin".to_string(),
				has_content:        false,
				lines:              None,
				bytes:              Some(9_000_000),
				unavailable_reason: Some(reason.to_string()),
				image:              None,
			}]),
		]);
		let held = artifacts(&state.transcript[0]);
		assert!(
			matches!(&held[..], [Artifact::File { has_content, unavailable_reason, .. }]
				if !*has_content && unavailable_reason.as_deref() == Some(reason)),
			"{reason}: the renderer is told why there is no body: {held:?}"
		);
	}
}

/// The projection's speaker table, swept from the model rather than listed. A
/// role added to `MessageRole` lands in the agent set and fails the pin, which
/// is the only way a new role cannot quietly draw as somebody else's words.
#[test]
fn only_two_roles_draw_on_the_turn_the_operator_owns() {
	let mut operator = Vec::new();
	let mut agent = Vec::new();
	for role in MessageRole::ALL {
		let state = seeded(vec![
			("u1", None, MessageRole::User, vec![ContentBlock::Text { text: "prompt".to_string() }]),
			("x1", Some("u1"), role, vec![mention("README.md")]),
		]);
		let as_operator = state.transcript.iter().any(|turn| {
			matches!(turn, Turn::OperatorArtifacts { artifacts, .. } if !artifacts.is_empty())
		});
		let as_agent = state
			.transcript
			.iter()
			.any(|turn| matches!(turn, Turn::Agent { blocks, .. } if !blocks.is_empty()));
		match (as_operator, as_agent) {
			(true, false) => operator.push(role),
			(false, true) => agent.push(role),
			_ => panic!("{role:?} drew the file in neither place or both: {:?}", state.transcript),
		}
	}

	assert_eq!(
		operator,
		vec![MessageRole::User, MessageRole::FileMention],
		"only the prompt and the files it read are the operator's words"
	);
	assert_eq!(
		agent,
		vec![
			MessageRole::Developer,
			MessageRole::Assistant,
			MessageRole::ToolResult,
			MessageRole::BashExecution,
			MessageRole::PythonExecution,
			MessageRole::Custom,
			MessageRole::BranchSummary,
			MessageRole::CompactionSummary,
			MessageRole::Lifecycle,
			MessageRole::Unknown,
		],
		"every other role draws in the turn that came back"
	);
}
