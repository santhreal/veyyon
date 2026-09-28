//! Every role the host records draws in its own register: the operator's
//! words in the bubble at the right, the agent's as prose at the left, and
//! every other role under the label that names it.
//!
//! WHY: a record that was neither a prompt nor a reply drew as unlabelled
//! agent prose, so a tool result, a shell run or a summary read as something
//! the agent said. The sweep reads `MessageRole` from the model at run time
//! and `register` and `recorded_by` match it with no wildcard, so a role
//! added to the model does not compile here until it states its register.
//! Per role the sweep pins the piece planned, the words drawn, the side they
//! are drawn on and the words a copy of the item takes. An execution and a
//! summary name the role that recorded them, and a side question and its
//! answer read under their own names rather than the role's.
//!
//! Gap: glyph colors are not read; full-text search over a session is the
//! host's, not the window's.

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::transcript::plan::copy_text;
use veyyon_desktop_model::{ContentBlock, MessageRole};

use super::{
	entry,
	items::{Side, drawn_by, forms, side_of},
	opened, snapshot, text, thread,
};

/// How a role's text draws.
#[derive(Debug, Clone, Copy)]
enum Register {
	/// In the operator's bubble.
	Bubble,
	/// As the agent's prose.
	Prose,
	/// As a note under a label, marking a boundary of the context or not.
	Note(&'static str, bool),
}

/// The register a role's text draws in, and the side it draws on.
const fn register(role: MessageRole) -> (Register, Side) {
	match role {
		MessageRole::User => (Register::Bubble, Side::Operator),
		MessageRole::Assistant => (Register::Prose, Side::Agent),
		MessageRole::Developer => (Register::Note("Developer", false), Side::Agent),
		MessageRole::ToolResult => (Register::Note("Tool result", false), Side::Agent),
		MessageRole::BashExecution => (Register::Note("Shell execution", false), Side::Agent),
		MessageRole::PythonExecution => (Register::Note("Python execution", false), Side::Agent),
		MessageRole::Custom => (Register::Note("Custom", false), Side::Agent),
		MessageRole::BranchSummary => (Register::Note("Branch summary", true), Side::Agent),
		MessageRole::CompactionSummary => (Register::Note("Compaction summary", true), Side::Agent),
		// A file is read on behalf of the prompt that named it.
		MessageRole::FileMention => (Register::Note("File", false), Side::Operator),
		MessageRole::Lifecycle => (Register::Note("Lifecycle", false), Side::Agent),
		MessageRole::Unknown => (Register::Note("Unknown", false), Side::Agent),
	}
}

#[gpui::test]
fn every_role_draws_its_text_in_its_register_on_its_side(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	for (revision, role) in (2..).zip(MessageRole::iter()) {
		let id = format!("r{revision}");
		let record = entry(&id, None, role, vec![text("Recorded text")]);
		let copied = copy_text(&record);
		thread.apply(vec![snapshot(revision, vec![record])]);
		let (register, side) = register(role);
		let (pieces, words) = match register {
			Register::Bubble => ("bubble: Recorded text".to_owned(), vec!["Recorded text"]),
			Register::Prose => ("prose #0".to_owned(), vec!["Recorded text"]),
			Register::Note(label, boundary) => {
				let edge = if boundary { " (boundary)" } else { "" };
				(format!("note {label}: Recorded text{edge}"), vec![label, "Recorded text"])
			},
		};
		let planned = forms(&mut thread, 0);
		let drew = drawn_by(&mut thread, &id);
		let drawn_side = side_of(&mut thread, &id);
		if planned != [pieces]
			|| drew != words
			|| drawn_side != Some(side)
			|| copied != "Recorded text"
		{
			broke.push(format!(
				"{role:?} planned {planned:?}, drew {drew:?} on {drawn_side:?} and copies {copied:?}"
			));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a role is not drawn in its register");
}

/// What an execution names as its runner and a summary as its kind when a
/// record of `role` holds them; `None` for the operator's prompt, which draws
/// only its words and the files and pictures it attached.
const fn recorded_by(role: MessageRole) -> Option<(&'static str, &'static str)> {
	match role {
		MessageRole::User => None,
		MessageRole::BashExecution => Some(("Shell", "Summary")),
		MessageRole::PythonExecution => Some(("Python", "Summary")),
		MessageRole::BranchSummary => Some(("shared", "Branch summary")),
		MessageRole::CompactionSummary => Some(("shared", "Compaction summary")),
		MessageRole::Developer
		| MessageRole::Assistant
		| MessageRole::ToolResult
		| MessageRole::Custom
		| MessageRole::FileMention
		| MessageRole::Lifecycle
		| MessageRole::Unknown => Some(("shared", "Summary")),
	}
}

#[gpui::test]
fn an_execution_and_a_summary_name_the_role_that_recorded_them(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	let mut prompts = Vec::new();
	for (revision, role) in (2..).zip(MessageRole::iter()) {
		let Some((runner, summary)) = recorded_by(role) else {
			prompts.push(role);
			continue;
		};
		let id = format!("e{revision}");
		let content = vec![
			ContentBlock::Execution {
				language:  "shared".to_owned(),
				command:   Some("run".to_owned()),
				output:    "result".to_owned(),
				exit_code: Some(2),
			},
			ContentBlock::Summary { kind: "context".to_owned(), text: "recorded".to_owned() },
		];
		thread.apply(vec![snapshot(revision, vec![entry(&id, None, role, content)])]);
		let caption = format!("{runner}: run · exit 2");
		let planned = forms(&mut thread, 0);
		let drew = drawn_by(&mut thread, &id);
		if planned
			!= [
				format!("pane {caption}: result"),
				format!("note {summary}: context: recorded (boundary)"),
			] || drew != [caption.as_str(), "result", summary, "context: recorded"]
		{
			broke.push(format!("{role:?} planned {planned:?} and drew {drew:?}"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a run or a summary does not name its role");
	assert_eq!(prompts, [MessageRole::User], "only the prompt is left out of the sweep");
}

#[gpui::test]
fn a_side_question_and_its_answer_read_under_their_own_names_and_any_other_record_as_custom(
	cx: &mut TestAppContext,
) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	for (revision, (discriminator, label)) in (2..).zip([
		("side_question", "Side question"),
		("side_answer", "Side answer"),
		("command_output", "Custom"),
		("", "Custom"),
	]) {
		let id = format!("c{revision}");
		let mut record = entry(&id, None, MessageRole::Custom, vec![text("Recorded text")]);
		record.raw_discriminator = discriminator.to_owned();
		thread.apply(vec![snapshot(revision, vec![record])]);
		let planned = forms(&mut thread, 0);
		let drew = drawn_by(&mut thread, &id);
		if planned != [format!("note {label}: Recorded text")] || drew != [label, "Recorded text"] {
			broke.push(format!("`{discriminator}` planned {planned:?} and drew {drew:?}"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a custom record reads under the wrong name");
}
