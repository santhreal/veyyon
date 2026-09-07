//! The transcript's turns: the active branch of the tree, read as what the
//! operator said and what came back.

use std::{fmt::Write as _, sync::Arc};

use serde_json::Value;
use veyyon_desktop_model::{ContentBlock, MessageRole, TranscriptEntry, TranscriptTree};
use veyyon_desktop_surface::{Artifact, Block, Turn};

/// How many lines a mono pane keeps before the rest is counted, not shown.
///
/// A command's output can run to the tens of thousands of lines, and a
/// transcript that holds all of them draws none of them in time.
pub const PANE_LINE_CEILING: usize = 200;

/// The entries on the active branch, oldest first.
///
/// A tree with an active leaf is read back along its parent chain; a tree
/// without one is read along its roots, which is the shape of a transcript
/// that never branched.
fn active_path(tree: &TranscriptTree) -> Vec<&TranscriptEntry> {
	let Some(leaf) = tree.active_leaf.as_ref() else {
		return tree
			.root_entries
			.iter()
			.filter_map(|id| tree.get(id))
			.collect();
	};
	let mut path = Vec::with_capacity(tree.len());
	let mut cursor = tree.get(leaf);
	while let Some(entry) = cursor {
		path.push(entry);
		cursor = entry.parent.as_ref().and_then(|id| tree.get(id));
	}
	path.reverse();
	path
}

/// The turns of a transcript, oldest first.
///
/// One operator entry is one turn. Everything the agent produced between two
/// operator entries — its prose, its calls, their results, the runs it made —
/// is one agent turn, because that is how the operator reads it: what they
/// said, then what came back.
pub(super) fn turns(tree: &TranscriptTree) -> Vec<Turn> {
	let mut turns = Vec::new();
	for entry in active_path(tree) {
		push_entry(&mut turns, entry);
	}
	turns
}

/// Appends an entry to the run of turns, merging agent output into the open
/// agent turn.
pub(super) fn push_entry(turns: &mut Vec<Turn>, entry: &TranscriptEntry) {
	if entry.content.is_empty() {
		return;
	}
	if entry.role == MessageRole::User {
		let mut text = String::new();
		let mut artifacts = Vec::new();
		let mut has_segment = false;
		for block in &entry.content {
			if let Some(artifact) = artifact_of(block) {
				artifacts.push(artifact);
				continue;
			}
			if !matches!(block, ContentBlock::Text { .. } | ContentBlock::Video { .. }) {
				continue;
			}
			if has_segment {
				text.push('\n');
			}
			has_segment = true;
			match block {
				ContentBlock::Text { text: segment } => text.push_str(segment),
				ContentBlock::Video { media_type, bytes } => {
					let _ = write!(
						text,
						"[video {media_type}, {}]",
						veyyon_desktop_surface::composer::human_bytes(*bytes)
					);
				},
				_ => {},
			}
		}
		if artifacts.is_empty() {
			turns.push(Turn::Operator(text));
		} else {
			turns.push(Turn::OperatorArtifacts { text, artifacts });
		}
		return;
	}

	if !matches!(turns.last(), Some(Turn::Agent(_))) {
		turns.push(Turn::Agent(Vec::new()));
	}
	if let Some(Turn::Agent(blocks)) = turns.last_mut() {
		for block in &entry.content {
			push_block(blocks, block, entry.role);
		}
	}
}

fn artifact_of(block: &ContentBlock) -> Option<Artifact> {
	match block {
		ContentBlock::Image { media_type, data, alt } => Some(Artifact::Image {
			media_type: media_type.clone(),
			data:       Arc::from(data.as_slice()),
			alt:        alt.clone(),
		}),
		ContentBlock::FileMention { path, has_content, lines, bytes, unavailable_reason, image } => {
			Some(Artifact::File {
				path:               path.clone(),
				has_content:        *has_content,
				lines:              *lines,
				bytes:              *bytes,
				unavailable_reason: unavailable_reason.clone(),
				image:              image.as_ref().map(|data| Arc::from(data.as_slice())),
			})
		},
		_ => None,
	}
}

fn push_block(blocks: &mut Vec<Block>, block: &ContentBlock, role: MessageRole) {
	match block {
		ContentBlock::Text { text } => {
			let label = match role {
				MessageRole::User | MessageRole::Assistant => None,
				MessageRole::Developer => Some("Developer"),
				MessageRole::Custom => Some("Custom"),
				MessageRole::ToolResult => Some("Tool result"),
				MessageRole::BashExecution => Some("Shell execution"),
				MessageRole::PythonExecution => Some("Python execution"),
				MessageRole::BranchSummary => Some("Branch summary"),
				MessageRole::CompactionSummary => Some("Compaction summary"),
				MessageRole::FileMention => Some("File"),
				MessageRole::Lifecycle => Some("Lifecycle"),
				MessageRole::Unknown => Some("Unknown"),
			};
			if let Some(label) = label {
				blocks.push(Block::Note {
					label,
					text: text.clone(),
					boundary: matches!(
						role,
						MessageRole::BranchSummary | MessageRole::CompactionSummary
					),
				});
			} else {
				blocks.push(Block::Prose(text.clone()));
			}
		},
		ContentBlock::Thinking { text } => blocks.push(Block::Reason(text.clone())),
		ContentBlock::RedactedThinking { marker } => {
			blocks.push(Block::Reason(format!("redacted ({marker})")));
		},
		ContentBlock::ToolCall { id, name, arguments } => blocks.push(Block::Invoke {
			call_id: id.clone(),
			tool:    name.clone(),
			target:  target_of(arguments),
			result:  None,
		}),
		ContentBlock::ToolResult { tool, content, is_error } => {
			let lines = result_lines(content, *is_error);
			let open = blocks.iter_mut().rev().find_map(|block| match block {
				Block::Invoke { call_id, result, .. } if result.is_none() && call_id == tool => {
					Some(result)
				},
				_ => None,
			});
			match open {
				Some(result) => *result = Some(lines.join("\n")),
				None => blocks.push(Block::Pane { caption: tool.clone(), lines }),
			}
		},
		ContentBlock::Execution { language, command, output, exit_code } => {
			let execution = match role {
				MessageRole::BashExecution => "Shell",
				MessageRole::PythonExecution => "Python",
				_ => language.as_str(),
			};
			let mut caption = match command {
				Some(command) => format!("{execution}: {command}"),
				None => execution.to_string(),
			};
			if let Some(code) = exit_code
				&& *code != 0
			{
				let _ = write!(caption, " · exit {code}");
			}
			blocks.push(Block::Pane { caption, lines: pane_lines(output) });
		},
		ContentBlock::FileMention { .. } | ContentBlock::Image { .. } => {
			blocks.extend(artifact_of(block).map(Block::Artifact));
		},
		ContentBlock::Diff { raw } => {
			blocks.push(Block::Pane { caption: "diff".to_string(), lines: pane_lines(raw) });
		},
		ContentBlock::ModelChange { provider, model } => {
			blocks.push(Block::Note {
				label:    "Model",
				text:     format!("{provider}/{model}"),
				boundary: false,
			});
		},
		ContentBlock::ThinkingChange { level } => {
			blocks.push(Block::Note {
				label:    "Thinking",
				text:     level.clone(),
				boundary: false,
			});
		},
		ContentBlock::Lifecycle { phase, reason } => blocks.push(Block::Note {
			label:    "Lifecycle",
			text:     match reason {
				Some(reason) => format!("{phase}: {reason}"),
				None => phase.clone(),
			},
			boundary: false,
		}),
		ContentBlock::Summary { kind, text } => {
			let label = match role {
				MessageRole::BranchSummary => "Branch summary",
				MessageRole::CompactionSummary => "Compaction summary",
				_ => "Summary",
			};
			blocks.push(Block::Note { label, text: format!("{kind}: {text}"), boundary: true });
		},
		ContentBlock::Video { media_type, bytes } => blocks.push(Block::Prose(format!(
			"[video {media_type}, {}]",
			veyyon_desktop_surface::composer::human_bytes(*bytes)
		))),
		ContentBlock::Fallback { producer, value } => blocks.push(Block::Unknown {
			producer: format!("Fallback: {producer}"),
			lines:    pane_lines(&value.to_string()),
		}),
		ContentBlock::Unknown { tag, value } => blocks.push(Block::Unknown {
			producer: format!("Unknown: {tag}"),
			lines:    pane_lines(&value.to_string()),
		}),
	}
}

/// The one argument a tool call is best summarised by.
fn target_of(arguments: &Value) -> String {
	const KEYS: [&str; 8] =
		["path", "file_path", "command", "cmd", "pattern", "query", "url", "input"];
	let Some(object) = arguments.as_object() else {
		return value_text(arguments)
			.lines()
			.next()
			.unwrap_or_default()
			.to_string();
	};
	KEYS
		.iter()
		.find_map(|key| object.get(*key).and_then(Value::as_str))
		.or_else(|| object.values().find_map(Value::as_str))
		.unwrap_or_default()
		.to_string()
}

fn value_text(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		Value::Null => String::new(),
		other => other.to_string(),
	}
}

fn result_lines(value: &Value, is_error: bool) -> Vec<String> {
	let mut lines = pane_lines(&value_text(value));
	if is_error {
		if let Some(first) = lines.first_mut() {
			first.insert_str(0, "error: ");
		} else {
			lines.push("error: ".to_string());
		}
	}
	lines
}

/// The lines of a pane, held to the ceiling with the remainder counted.
fn pane_lines(text: &str) -> Vec<String> {
	let total = text.lines().count();
	let mut lines: Vec<String> = text
		.lines()
		.take(PANE_LINE_CEILING)
		.map(str::to_string)
		.collect();
	if total > PANE_LINE_CEILING {
		lines.push(format!("… {} more lines", total - PANE_LINE_CEILING));
	}
	lines
}
