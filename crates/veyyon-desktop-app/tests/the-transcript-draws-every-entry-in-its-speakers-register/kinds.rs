//! Every block kind the host records reaches the window as the piece that
//! states it.
//!
//! WHY: the plan draws a block through one match arm per kind, and a kind no
//! arm draws is dropped without a sign: the turn still draws, one block
//! short. The sweep reads `BlockKind` from the model at run time and pins,
//! per kind, the piece planned and the words the item drew, by exact
//! equality. `sample`, `drawn` and `picture` match with no wildcard, so a
//! kind added to the model does not compile here until it states what it
//! draws, and every kind that broke is named before the assertion fails. A
//! picture draws no words, so it is proven drawn by the height it lays its
//! item out at.
//!
//! Gap: glyph colors, the markdown renderer's own output and a picture's
//! pixels are not read.

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	BlockKind, ContentBlock, MessageRole,
	tool_view::{StatusRowView, ToolView},
};

use super::{
	bitmap, entry,
	items::{click_run, drawn_by, forms, laid_out, redrawn},
	opened, text, thread,
};

/// One block of `kind`, as the host records it.
fn sample(kind: BlockKind) -> ContentBlock {
	match kind {
		BlockKind::Text => text("prose the agent wrote"),
		BlockKind::Image => ContentBlock::Image {
			media_type: "image/bmp".to_owned(),
			data:       bitmap(64, 48),
			alt:        Some("Diagram of the parser".to_owned()),
		},
		BlockKind::Video => {
			ContentBlock::Video { media_type: "video/mp4".to_owned(), bytes: 12_400_000 }
		},
		BlockKind::Thinking => ContentBlock::Thinking { text: "why it chose the parser".to_owned() },
		BlockKind::RedactedThinking => ContentBlock::RedactedThinking { marker: "r".to_owned() },
		BlockKind::ToolCall => ContentBlock::ToolCall {
			id:           "call-1".to_owned(),
			name:         "read".to_owned(),
			arguments:    serde_json::json!({ "path": "src/lib.rs" }),
			presentation: None,
		},
		BlockKind::ToolResult => ContentBlock::ToolResult {
			tool:         "read".to_owned(),
			content:      serde_json::json!("12 lines read"),
			is_error:     false,
			presentation: None,
		},
		BlockKind::Execution => ContentBlock::Execution {
			language:  "bash".to_owned(),
			command:   Some("ls src".to_owned()),
			output:    "lib.rs\nmain.rs".to_owned(),
			exit_code: Some(0),
		},
		BlockKind::FileMention => ContentBlock::FileMention {
			path:               "README.md".to_owned(),
			has_content:        false,
			lines:              None,
			bytes:              None,
			unavailable_reason: None,
			image:              None,
		},
		BlockKind::Custom => ContentBlock::Custom {
			variant: "irc_message".to_owned(),
			view:    std::sync::Arc::new(ToolView::StatusRow(StatusRowView::new("IRC from Scout"))),
		},
		BlockKind::Diff => ContentBlock::Diff { raw: "-old line\n+new line".to_owned() },
		BlockKind::ModelChange => ContentBlock::ModelChange {
			provider: "anthropic".to_owned(),
			model:    "claude-opus-4-1".to_owned(),
		},
		BlockKind::ThinkingChange => ContentBlock::ThinkingChange { level: "high".to_owned() },
		BlockKind::ModeChange => ContentBlock::ModeChange { mode: "plan_paused".to_owned() },
		BlockKind::Lifecycle => {
			ContentBlock::Lifecycle { phase: "start".to_owned(), reason: Some("resumed".to_owned()) }
		},
		BlockKind::Summary => ContentBlock::Summary {
			kind: "compaction".to_owned(),
			text: "the earlier turns".to_owned(),
		},
		BlockKind::Fallback => ContentBlock::Fallback {
			producer: "ext".to_owned(),
			value:    serde_json::json!(["kept", 1]),
		},
		BlockKind::Unknown => ContentBlock::Unknown {
			tag:   "future_block".to_owned(),
			value: serde_json::json!("line one"),
		},
	}
}

/// What an agent's item holding the sample of one kind plans and draws.
struct Drawn {
	/// The forms of the pieces planned, with the finished turn unfolded.
	pieces: &'static [&'static str],
	/// The run clicked before the words are read: a finished turn's calls
	/// fold under its summary until it is opened.
	opens:  Option<&'static str>,
	/// The words the item drew, in paint order.
	words:  &'static [&'static str],
}

const fn drawn(kind: BlockKind) -> Drawn {
	match kind {
		BlockKind::Text => {
			Drawn { pieces: &["prose #0"], opens: None, words: &["prose the agent wrote"] }
		},
		// The picture decodes, so the words it was sent with are not drawn.
		BlockKind::Image => {
			Drawn { pieces: &["image #0: Diagram of the parser"], opens: None, words: &[] }
		},
		BlockKind::Video => Drawn {
			pieces: &["note Video: [video video/mp4, 11.8 MB]"],
			opens:  None,
			words:  &["Video", "[video video/mp4, 11.8 MB]"],
		},
		BlockKind::Thinking => {
			Drawn { pieces: &["thought #0"], opens: None, words: &["▸ Thought"] }
		},
		BlockKind::RedactedThinking => Drawn {
			pieces: &["thought #0 (redacted)"],
			opens:  None,
			words:  &["▸ Thought (redacted)"],
		},
		BlockKind::ToolCall => Drawn {
			pieces: &[
				"worked from 0: Worked for 0s · 1 step (open)",
				"tool call-1 Aborted: Read src/lib.rs",
			],
			opens:  Some("▸ Worked for 0s · 1 step"),
			words:  &["▾ Worked for 0s · 1 step", "⊘", "Read", "src/lib.rs"],
		},
		BlockKind::ToolResult => Drawn {
			pieces: &["pane read: 12 lines read"],
			opens:  None,
			words:  &["read", "12 lines read"],
		},
		BlockKind::Execution => Drawn {
			pieces: &["pane bash: ls src: lib.rs | main.rs"],
			opens:  None,
			words:  &["bash: ls src", "lib.rs", "main.rs"],
		},
		BlockKind::FileMention => {
			Drawn { pieces: &["file README.md"], opens: None, words: &["README.md"] }
		},
		BlockKind::Custom => Drawn {
			pieces: &["report irc_message: IRC from Scout"],
			opens:  None,
			words:  &["irc message", "IRC from Scout"],
		},
		BlockKind::Diff => Drawn {
			pieces: &["pane diff: -old line | +new line (diff)"],
			opens:  None,
			words:  &["diff", "-old line", "+new line"],
		},
		BlockKind::ModelChange => Drawn {
			pieces: &["note Model: anthropic/claude-opus-4-1"],
			opens:  None,
			words:  &["Model", "anthropic/claude-opus-4-1"],
		},
		BlockKind::ThinkingChange => {
			Drawn { pieces: &["note Thinking: high"], opens: None, words: &["Thinking", "high"] }
		},
		BlockKind::ModeChange => Drawn {
			pieces: &["note Mode: plan paused"],
			opens:  None,
			words:  &["Mode", "plan paused"],
		},
		BlockKind::Lifecycle => Drawn {
			pieces: &["note Lifecycle: start: resumed"],
			opens:  None,
			words:  &["Lifecycle", "start: resumed"],
		},
		BlockKind::Summary => Drawn {
			pieces: &["note Summary: compaction: the earlier turns (boundary)"],
			opens:  None,
			words:  &["Summary", "compaction: the earlier turns"],
		},
		BlockKind::Fallback => Drawn {
			pieces: &[r#"pane Fallback: ext: ["kept",1]"#],
			opens:  None,
			words:  &["Fallback: ext", r#"["kept",1]"#],
		},
		BlockKind::Unknown => Drawn {
			pieces: &[r#"pane Unknown: future_block: "line one""#],
			opens:  None,
			words:  &["Unknown: future_block", r#""line one""#],
		},
	}
}

#[gpui::test]
fn every_block_kind_is_planned_as_the_piece_that_states_it_and_drawn_as_its_words(
	cx: &mut TestAppContext,
) {
	let mut broke = Vec::new();
	for kind in BlockKind::iter() {
		let Drawn { pieces, opens, words } = drawn(kind);
		let content = vec![sample(kind)];
		let mut thread = thread(cx, opened(vec![entry("a", None, MessageRole::Assistant, content)]));
		redrawn(&mut thread);
		let planned = forms(&mut thread, 0);
		if let Some(run) = opens {
			click_run(&mut thread, run);
		}
		let drew = drawn_by(&mut thread, "a");
		if planned != pieces || drew != words {
			broke.push(format!("{kind:?} planned {planned:?} and drew {drew:?}"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a kind is planned or drawn as something else");
}

/// A block of `kind` carrying a picture of `data`, or `None` for a kind that
/// carries none.
fn picture(kind: BlockKind, data: Vec<u8>) -> Option<ContentBlock> {
	match kind {
		BlockKind::Image => Some(ContentBlock::Image {
			media_type: "image/bmp".to_owned(),
			data,
			alt: Some("Diagram of the parser".to_owned()),
		}),
		BlockKind::FileMention => Some(ContentBlock::FileMention {
			path:               "shots/parser.bmp".to_owned(),
			has_content:        true,
			lines:              None,
			bytes:              None,
			unavailable_reason: None,
			image:              Some(data),
		}),
		BlockKind::Text
		| BlockKind::Video
		| BlockKind::Thinking
		| BlockKind::RedactedThinking
		| BlockKind::ToolCall
		| BlockKind::ToolResult
		| BlockKind::Execution
		| BlockKind::Custom
		| BlockKind::Diff
		| BlockKind::ModelChange
		| BlockKind::ThinkingChange
		| BlockKind::ModeChange
		| BlockKind::Lifecycle
		| BlockKind::Summary
		| BlockKind::Fallback
		| BlockKind::Unknown => None,
	}
}

/// The height the agent's item holding `block` lays out at.
fn height_of(cx: &mut TestAppContext, block: ContentBlock) -> f32 {
	let mut thread = thread(cx, opened(vec![entry("a", None, MessageRole::Assistant, vec![block])]));
	let item = laid_out(&mut thread, "transcript.entry:a").expect("the item was laid out");
	f32::from(item.size.height)
}

#[gpui::test]
fn every_picture_lays_its_item_out_at_the_pictures_own_height(cx: &mut TestAppContext) {
	let mut broke = Vec::new();
	for kind in BlockKind::iter() {
		let (Some(short), Some(long)) =
			(picture(kind, bitmap(64, 48)), picture(kind, bitmap(64, 148)))
		else {
			continue;
		};
		let grew = height_of(cx, long) - height_of(cx, short);
		if grew.round() as i32 != 100 {
			broke.push(format!("{kind:?} grew {grew}px for a picture 100px taller"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a picture is not laid out at its height");
}
