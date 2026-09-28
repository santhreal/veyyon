//! A picture or a named file keeps what the host recorded of it whichever
//! role recorded it, and a record the window cannot read keeps its raw value.
//!
//! WHY: a file's line count, size or unavailability and a picture's bytes
//! and words were dropped when entries became what the window draws. The
//! sweeps read `MessageRole` and `BlockKind` from the model at run time,
//! cross every role with every combination of a named file's optional
//! fields, and pin the pieces planned, the words drawn, the side they are
//! drawn on and the words a copy of the item takes. The prompt and a file it
//! named draw at the right and every other role at the left, since a file
//! drawn as the agent's claims the agent read a file it never called a tool
//! for. `side` and `raw` match with no wildcard, so a role or a kind added to
//! the model does not compile here until it states its side or whether it is
//! a record the window cannot read.
//!
//! Gap: a decoded picture's pixels are not read; it is proven drawn by the
//! fallback words it did not draw.

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::transcript::plan::copy_text;
use veyyon_desktop_model::{BlockKind, ContentBlock, MessageRole};

use super::{
	bitmap, entry,
	items::{Side, drawn_by, forms, redrawn, side_of},
	opened, snapshot, text, thread,
};

/// The file every mention names; a bitmap, so a picture of it decodes.
const PATH: &str = "shots/recorded.bmp";

/// The side a record of `role` draws on.
const fn side(role: MessageRole) -> Side {
	match role {
		MessageRole::User | MessageRole::FileMention => Side::Operator,
		MessageRole::Developer
		| MessageRole::Assistant
		| MessageRole::ToolResult
		| MessageRole::BashExecution
		| MessageRole::PythonExecution
		| MessageRole::Custom
		| MessageRole::BranchSummary
		| MessageRole::CompactionSummary
		| MessageRole::Lifecycle
		| MessageRole::Unknown => Side::Agent,
	}
}

#[gpui::test]
fn a_named_file_keeps_its_detail_and_its_picture_under_every_role(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	let mut revision = 1;
	for role in MessageRole::iter() {
		for fields in 0_u8..32 {
			revision += 1;
			let has_content = fields & 1 != 0;
			let lines = (fields & 2 != 0).then_some(12);
			let bytes = (fields & 4 != 0).then_some(4096);
			let unavailable_reason = (fields & 8 != 0).then(|| "Permission denied".to_owned());
			let image = (fields & 16 != 0).then(|| bitmap(64, 48));
			// Why the file could not be read outranks its length, and its
			// length in lines outranks its size.
			let detail = match (&unavailable_reason, lines, bytes) {
				(Some(reason), ..) => reason.clone(),
				(None, Some(_), _) => "12 lines".to_owned(),
				(None, None, Some(_)) => "4.0 KB".to_owned(),
				(None, None, None) => String::new(),
			};
			let mut pieces = vec![if detail.is_empty() {
				format!("file {PATH}")
			} else {
				format!("file {PATH}: {detail}")
			}];
			if image.is_some() {
				pieces.push(format!("image #0: {PATH}"));
			}
			let mut words = vec![PATH];
			if !detail.is_empty() {
				words.push(&detail);
			}
			let id = format!("f{revision}");
			let mention = ContentBlock::FileMention {
				path: PATH.to_owned(),
				has_content,
				lines,
				bytes,
				unavailable_reason,
				image,
			};
			let record = entry(&id, None, role, vec![mention]);
			let copied = copy_text(&record);
			thread.apply(vec![snapshot(revision, vec![record])]);
			redrawn(&mut thread);
			let planned = forms(&mut thread, 0);
			let drew = drawn_by(&mut thread, &id);
			let drawn_side = side_of(&mut thread, &id);
			if planned != pieces || drew != words || drawn_side != Some(side(role)) || copied != PATH {
				broke.push(format!(
					"{role:?} with fields {fields:05b} planned {planned:?}, drew {drew:?} on \
					 {drawn_side:?} and copies {copied:?}"
				));
			}
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a named file lost what the host recorded of it");
}

#[gpui::test]
fn an_attached_picture_keeps_its_bytes_and_its_words_under_every_role(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	let mut revision = 1;
	for role in MessageRole::iter() {
		// A picture that decodes draws no words; one that does not draws the
		// words it was sent with, on the side of the role that sent it.
		for (data, words) in [(bitmap(64, 48), None), (vec![1, 2, 3], Some("Diagram"))] {
			revision += 1;
			let id = format!("p{revision}");
			let picture = ContentBlock::Image {
				media_type: "image/bmp".to_owned(),
				data,
				alt: Some("Diagram".to_owned()),
			};
			thread.apply(vec![snapshot(revision, vec![entry(&id, None, role, vec![picture])])]);
			redrawn(&mut thread);
			let planned = forms(&mut thread, 0);
			let drew = drawn_by(&mut thread, &id);
			let drawn_side = side_of(&mut thread, &id);
			let (expected, sided) = match words {
				Some(words) => (vec![words], Some(side(role))),
				None => (Vec::new(), None),
			};
			if planned != ["image #0: Diagram"] || drew != expected || drawn_side != sided {
				broke.push(format!(
					"{role:?} with a picture that {} planned {planned:?} and drew {drew:?} on \
					 {drawn_side:?}",
					if words.is_some() {
						"does not decode"
					} else {
						"decodes"
					}
				));
			}
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a picture lost its bytes or its words");
}

#[gpui::test]
fn a_prompt_draws_its_words_in_one_bubble_before_its_attachments(cx: &mut TestAppContext) {
	let mut thread = thread(
		cx,
		opened(vec![entry("p", None, MessageRole::User, vec![
			text(""),
			ContentBlock::Image {
				media_type: "image/bmp".to_owned(),
				data:       bitmap(8, 8),
				alt:        None,
			},
			text("Caption"),
			text(""),
		])]),
	);
	assert_eq!(
		forms(&mut thread, 0),
		["bubble: Caption", "image #1"],
		"a prompt's empty segments drew lines or its words did not lead its attachments"
	);
}

/// A record of `kind` holding `value`, with the caption its pane reads, or
/// `None` for a kind the window reads.
fn raw(kind: BlockKind, value: &serde_json::Value) -> Option<(ContentBlock, &'static str)> {
	match kind {
		BlockKind::Fallback => Some((
			ContentBlock::Fallback { producer: "extension".to_owned(), value: value.clone() },
			"Fallback: extension",
		)),
		BlockKind::Unknown => Some((
			ContentBlock::Unknown { tag: "future".to_owned(), value: value.clone() },
			"Unknown: future",
		)),
		BlockKind::Text
		| BlockKind::Image
		| BlockKind::Video
		| BlockKind::Thinking
		| BlockKind::RedactedThinking
		| BlockKind::ToolCall
		| BlockKind::ToolResult
		| BlockKind::Execution
		| BlockKind::FileMention
		| BlockKind::Custom
		| BlockKind::Diff
		| BlockKind::ModelChange
		| BlockKind::ThinkingChange
		| BlockKind::ModeChange
		| BlockKind::Lifecycle
		| BlockKind::Summary => None,
	}
}

#[gpui::test]
fn a_record_the_window_cannot_read_draws_and_copies_its_raw_value(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	let mut raws = Vec::new();
	let mut revision = 1;
	let values = [
		serde_json::Value::Null,
		serde_json::json!({ "recorded": [1, true, "needle"] }),
		serde_json::json!("line one\nline two"),
	];
	for kind in BlockKind::iter() {
		for value in &values {
			let Some((block, caption)) = raw(kind, value) else {
				continue;
			};
			raws.push(kind);
			revision += 1;
			let id = format!("u{revision}");
			let record = entry(&id, None, MessageRole::Unknown, vec![block]);
			let copied = copy_text(&record);
			thread.apply(vec![snapshot(revision, vec![record])]);
			let recorded = value.to_string();
			let planned = forms(&mut thread, 0);
			let drew = drawn_by(&mut thread, &id);
			if planned != [format!("pane {caption}: {recorded}")]
				|| drew != [caption, recorded.as_str()]
				|| copied != recorded
			{
				broke.push(format!(
					"{kind:?} holding {recorded} planned {planned:?}, drew {drew:?} and copies \
					 {copied:?}"
				));
			}
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a record the window cannot read lost its raw value");
	assert_eq!(
		raws,
		[BlockKind::Fallback; 3]
			.into_iter()
			.chain([BlockKind::Unknown; 3])
			.collect::<Vec<_>>(),
		"the sweep did not reach every kind the window cannot read"
	);
}
