//! What each content block of an entry draws, and the operator's bubble.

use std::{fmt::Write as _, sync::Arc};

use veyyon_desktop_model::{ContentBlock, MessageRole, TranscriptEntry};

use super::{
	plan::{Opened, Piece, Plan, push_line},
	values::{human_bytes, mode_words, pane_lines, result_lines, role_label, video_words},
};

/// The operator's entry as one bubble of its words, with its attachments.
/// An entry that wrote no words draws no bubble: an empty text segment adds
/// no line, and an entry of attachments alone draws the attachments.
pub(super) fn plan_operator(entry: &TranscriptEntry, plan: &mut Plan) {
	let mut words = String::new();
	for (block_ix, block) in entry.content.iter().enumerate() {
		match block {
			ContentBlock::Text { text } if !text.is_empty() => push_line(&mut words, text),
			ContentBlock::Video { media_type, bytes } => {
				push_line(&mut words, &video_words(media_type, *bytes));
			},
			ContentBlock::Image { .. } | ContentBlock::FileMention { .. } => {
				plan_artifact(block_ix, block, plan);
			},
			_ => {},
		}
	}
	if !words.is_empty() {
		plan.pieces.insert(0, Piece::Bubble(words));
	}
}

/// An image, or a file and the picture of it the host read.
fn plan_artifact(block_ix: usize, block: &ContentBlock, plan: &mut Plan) {
	match block {
		ContentBlock::Image { alt, .. } => plan
			.pieces
			.push(Piece::Image { block: block_ix, alt: alt.clone() }),
		ContentBlock::FileMention { path, lines, bytes, unavailable_reason, image, .. } => {
			let detail = match (unavailable_reason, lines, bytes) {
				(Some(reason), ..) => reason.clone(),
				(None, Some(lines), _) => format!("{lines} lines"),
				(None, None, Some(bytes)) => human_bytes(*bytes),
				(None, None, None) => String::new(),
			};
			plan.pieces.push(Piece::File { path: path.clone(), detail });
			if image.is_some() {
				plan
					.pieces
					.push(Piece::Image { block: block_ix, alt: Some(path.clone()) });
			}
		},
		_ => {},
	}
}

/// The pieces `block` of `entry` draws, added to `plan`.
pub(super) fn plan_block(
	entry: &TranscriptEntry,
	block_ix: usize,
	block: &ContentBlock,
	opened: &Opened<'_>,
	plan: &mut Plan,
) {
	let pieces = &mut plan.pieces;
	match block {
		ContentBlock::Text { text } => match role_label(entry) {
			None => pieces.push(Piece::Prose { block: block_ix }),
			Some(label) => pieces.push(Piece::Note {
				label:    label.to_owned(),
				text:     text.clone(),
				boundary: matches!(
					entry.role,
					MessageRole::BranchSummary | MessageRole::CompactionSummary
				),
			}),
		},
		ContentBlock::Thinking { text } => {
			let open = opened.thoughts.contains(&(entry.id.clone(), block_ix));
			pieces.push(Piece::Thinking {
				block:    block_ix,
				text:     open.then(|| text.clone()),
				redacted: false,
			});
		},
		ContentBlock::RedactedThinking { .. } => {
			pieces.push(Piece::Thinking { block: block_ix, text: None, redacted: true });
		},
		ContentBlock::ToolCall { .. } => {},
		// A result no call row shows states its failure in its caption, as a
		// failed run states its exit code.
		ContentBlock::ToolResult { tool, content, is_error, .. } => pieces.push(Piece::Pane {
			caption: if *is_error {
				format!("{tool} · error")
			} else {
				tool.clone()
			},
			lines:   result_lines(content, *is_error),
			diff:    false,
		}),
		ContentBlock::Execution { language, command, output, exit_code } => {
			let run = match entry.role {
				MessageRole::BashExecution => "Shell",
				MessageRole::PythonExecution => "Python",
				_ => language.as_str(),
			};
			let mut caption = command
				.as_ref()
				.map_or_else(|| run.to_owned(), |command| format!("{run}: {command}"));
			if let Some(code) = exit_code.filter(|code| *code != 0) {
				let _ = write!(caption, " · exit {code}");
			}
			pieces.push(Piece::Pane { caption, lines: pane_lines(output), diff: false });
		},
		ContentBlock::Image { .. } | ContentBlock::FileMention { .. } => {
			plan_artifact(block_ix, block, plan);
		},
		ContentBlock::Video { media_type, bytes } => pieces.push(Piece::Note {
			label:    "Video".to_owned(),
			text:     video_words(media_type, *bytes),
			boundary: false,
		}),
		ContentBlock::Custom { variant, view } => {
			pieces.push(Piece::Report { variant: variant.clone(), view: Arc::clone(view) });
		},
		ContentBlock::Diff { raw } => pieces.push(Piece::Pane {
			caption: "diff".to_owned(),
			lines:   pane_lines(raw),
			diff:    true,
		}),
		ContentBlock::ModelChange { provider, model } => {
			pieces.push(note("Model", format!("{provider}/{model}")));
		},
		ContentBlock::ThinkingChange { level } => pieces.push(note("Thinking", level.clone())),
		ContentBlock::ModeChange { mode } => pieces.push(note("Mode", mode_words(mode))),
		ContentBlock::Lifecycle { phase, reason } => pieces.push(note(
			"Lifecycle",
			reason
				.as_ref()
				.map_or_else(|| phase.clone(), |reason| format!("{phase}: {reason}")),
		)),
		ContentBlock::Summary { kind, text } => {
			let label = match entry.role {
				MessageRole::BranchSummary => "Branch summary",
				MessageRole::CompactionSummary => "Compaction summary",
				_ => "Summary",
			};
			pieces.push(Piece::Note {
				label:    label.to_owned(),
				text:     format!("{kind}: {text}"),
				boundary: true,
			});
		},
		ContentBlock::Fallback { producer, value } => pieces.push(Piece::Pane {
			caption: format!("Fallback: {producer}"),
			lines:   pane_lines(&value.to_string()),
			diff:    false,
		}),
		ContentBlock::Unknown { tag, value } => pieces.push(Piece::Pane {
			caption: format!("Unknown: {tag}"),
			lines:   pane_lines(&value.to_string()),
			diff:    false,
		}),
	}
}

fn note(label: &str, text: String) -> Piece {
	Piece::Note { label: label.to_owned(), text, boundary: false }
}
