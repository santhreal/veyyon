//! What one transcript item draws, read out of the store before anything is
//! drawn.
//!
//! Reading and drawing are split so an item is planned while the store is
//! borrowed and drawn afterwards with the window free: the plan holds owned,
//! bounded data (a tool's output only when its row is open, a presentation as
//! a shared pointer) and never the entry itself.

use std::{
	collections::{HashMap, HashSet},
	fmt::Write as _,
	sync::Arc,
};

use veyyon_desktop_model::{
	ContentBlock, EntryId, MessageRole, SessionId, TranscriptEntry,
	tool_view::{ToolPresentation, ToolView, ViewStatus, view_rows},
};

use super::{
	turn::{TurnIndex, TurnSpan, is_answer},
	values::{pane_lines, result_lines, target_of, verb_of},
};
use crate::AppState;

/// One drawn piece of an item.
#[derive(Debug, Clone)]
pub enum Piece {
	/// The operator's words, in the right-aligned bubble.
	Bubble(String),
	/// Assistant prose at block `block` of the entry, drawn as markdown from
	/// the transcript's parsed-document cache.
	Prose { block: usize },
	/// A muted labelled line: a role other than the conversation, a model,
	/// thinking level or mode change, a lifecycle phase, a summary.
	Note { label: String, text: String, boundary: bool },
	/// A thought, one line until opened.
	Thinking { block: usize, text: Option<String>, redacted: bool },
	/// One tool call.
	Tool(ToolRow),
	/// The folded tool rows of a finished turn.
	Worked { anchor: usize, text: String, open: bool },
	/// Output lines under a caption.
	Pane { caption: String, lines: Vec<String>, diff: bool },
	/// A recorded message drawn through its own view.
	Report { variant: String, view: Arc<ToolView> },
	/// An image the entry carries at block `block`, decoded by the
	/// transcript's image cache.
	Image { block: usize, alt: Option<String> },
	/// A file the prompt named.
	File { path: String, detail: String },
	/// The error the turn ended with.
	Error(String),
	/// The model that produced a finished turn.
	Footer(String),
}

/// One tool row.
#[derive(Debug, Clone)]
pub struct ToolRow {
	/// The call id the host keys the call by.
	pub call_id:     String,
	/// `Read`, `Ran`, `Web search`.
	pub verb:        String,
	/// What the call acts on.
	pub target:      Option<String>,
	/// Where the call stands.
	pub status:      ViewStatus,
	/// From the call to its result.
	pub duration_ms: Option<u64>,
	/// Whether the output shows.
	pub open:        bool,
	/// The output, planned only while open.
	pub body:        Option<ToolBody>,
}

/// A tool's output.
#[derive(Debug, Clone)]
pub enum ToolBody {
	/// The tool's own presentation.
	View(Arc<ToolPresentation>),
	/// The result as lines.
	Lines(Vec<String>),
}

/// What an item draws.
#[derive(Debug, Clone)]
pub struct Plan {
	/// The entry the item is.
	pub id:       EntryId,
	/// The entry's revision, which keys its parsed prose.
	pub revision: u64,
	/// Whether the item sits in the operator's register, at the right.
	pub operator: bool,
	/// The pieces, top to bottom.
	pub pieces:   Vec<Piece>,
}

/// The view state a plan reads: which rows the operator opened or closed.
pub struct Opened<'a> {
	/// Tool rows toggled away from the host's default, by call id.
	pub tools:    &'a HashMap<String, bool>,
	/// Thoughts opened, by entry and block.
	pub thoughts: &'a HashSet<(EntryId, usize)>,
	/// Finished turns unfolded, by the display index they start at.
	pub turns:    &'a HashSet<usize>,
	/// Whether the session's agent is working, so its last turn is live.
	pub working:  bool,
}

/// Plans item `ix` of `session`, or `None` for an index the store does not
/// hold.
#[must_use]
pub fn plan_entry(
	app: &AppState,
	session: &SessionId,
	ix: usize,
	turns: &TurnIndex,
	opened: &Opened<'_>,
) -> Option<Plan> {
	let entry = app.entry_at(session, ix)?;
	let turn = turns.turn_at(ix);
	let live = opened.working && turns.is_last(ix);
	let mut plan = Plan {
		id:       entry.id.clone(),
		revision: entry.revision,
		operator: matches!(entry.role, MessageRole::User | MessageRole::FileMention),
		pieces:   Vec::new(),
	};
	if entry.role == MessageRole::User {
		plan_operator(entry, &mut plan);
		return Some(plan);
	}
	if let Some(turn) = turn
		&& is_answer(turn, entry)
	{
		return Some(plan);
	}
	let folded = turn.is_some_and(|turn| !live && turn.steps > 0 && !opened.turns.contains(&turn.range.start));
	for (block_ix, block) in entry.content.iter().enumerate() {
		if let ContentBlock::ToolCall { id, name, arguments, presentation } = block {
			if let Some(turn) = turn
				&& turn.first_tool == Some(ix)
				&& !live
				&& turn.steps > 0
				&& first_call(entry) == Some(block_ix)
			{
				plan.pieces.push(Piece::Worked { anchor: turn.range.start, text: turn.summary(), open: !folded });
			}
			if folded {
				continue;
			}
			let row = tool_row(app, session, entry, turn, live, opened, id, name, arguments, presentation.as_ref());
			plan.pieces.push(Piece::Tool(row));
			continue;
		}
		plan_block(entry, block_ix, block, opened, &mut plan);
	}
	if let Some(error) = entry.meta.as_ref().and_then(|meta| meta.error.clone()) {
		plan.pieces.push(Piece::Error(error));
	}
	if let Some(turn) = turn
		&& !live
		&& ix + 1 == turn.range.end
		&& let Some(model) = entry.meta.as_ref().and_then(|meta| meta.model.clone())
	{
		plan.pieces.push(Piece::Footer(model));
	}
	Some(plan)
}

fn first_call(entry: &TranscriptEntry) -> Option<usize> {
	entry.content.iter().position(|block| matches!(block, ContentBlock::ToolCall { .. }))
}

fn plan_operator(entry: &TranscriptEntry, plan: &mut Plan) {
	let mut words = String::new();
	for (block_ix, block) in entry.content.iter().enumerate() {
		match block {
			ContentBlock::Text { text } => push_line(&mut words, text),
			ContentBlock::Video { media_type, bytes } => push_line(&mut words, &video_words(media_type, *bytes)),
			ContentBlock::Image { .. } | ContentBlock::FileMention { .. } => {
				plan_artifact(block_ix, block, plan);
			},
			_ => {},
		}
	}
	plan.pieces.insert(0, Piece::Bubble(words));
}

fn plan_artifact(block_ix: usize, block: &ContentBlock, plan: &mut Plan) {
	match block {
		ContentBlock::Image { alt, .. } => plan.pieces.push(Piece::Image { block: block_ix, alt: alt.clone() }),
		ContentBlock::FileMention { path, lines, bytes, unavailable_reason, .. } => {
			let detail = match (unavailable_reason, lines, bytes) {
				(Some(reason), ..) => reason.clone(),
				(None, Some(lines), _) => format!("{lines} lines"),
				(None, None, Some(bytes)) => human_bytes(*bytes),
				(None, None, None) => String::new(),
			};
			plan.pieces.push(Piece::File { path: path.clone(), detail });
		},
		_ => {},
	}
}

fn plan_block(entry: &TranscriptEntry, block_ix: usize, block: &ContentBlock, opened: &Opened<'_>, plan: &mut Plan) {
	let pieces = &mut plan.pieces;
	match block {
		ContentBlock::Text { text } => {
			match role_label(entry) {
				None => pieces.push(Piece::Prose { block: block_ix }),
				Some(label) => pieces.push(Piece::Note {
					label: label.to_owned(),
					text: text.clone(),
					boundary: matches!(entry.role, MessageRole::BranchSummary | MessageRole::CompactionSummary),
				}),
			}
		},
		ContentBlock::Thinking { text } => {
			let open = opened.thoughts.contains(&(entry.id.clone(), block_ix));
			pieces.push(Piece::Thinking { block: block_ix, text: open.then(|| text.clone()), redacted: false });
		},
		ContentBlock::RedactedThinking { .. } => {
			pieces.push(Piece::Thinking { block: block_ix, text: None, redacted: true });
		},
		ContentBlock::ToolCall { .. } => {},
		ContentBlock::ToolResult { tool, content, is_error, .. } => pieces.push(Piece::Pane {
			caption: tool.clone(),
			lines:   result_lines(content, *is_error),
			diff:    false,
		}),
		ContentBlock::Execution { language, command, output, exit_code } => {
			let run = match entry.role {
				MessageRole::BashExecution => "Shell",
				MessageRole::PythonExecution => "Python",
				_ => language.as_str(),
			};
			let mut caption = command.as_ref().map_or_else(|| run.to_owned(), |command| format!("{run}: {command}"));
			if let Some(code) = exit_code.filter(|code| *code != 0) {
				let _ = write!(caption, " · exit {code}");
			}
			pieces.push(Piece::Pane { caption, lines: pane_lines(output), diff: false });
		},
		ContentBlock::Image { .. } | ContentBlock::FileMention { .. } => plan_artifact(block_ix, block, plan),
		ContentBlock::Video { media_type, bytes } => pieces.push(Piece::Note {
			label:    "Video".to_owned(),
			text:     video_words(media_type, *bytes),
			boundary: false,
		}),
		ContentBlock::Custom { variant, view } => {
			pieces.push(Piece::Report { variant: variant.clone(), view: Arc::clone(view) });
		},
		ContentBlock::Diff { raw } => pieces.push(Piece::Pane { caption: "diff".to_owned(), lines: pane_lines(raw), diff: true }),
		ContentBlock::ModelChange { provider, model } => pieces.push(note("Model", format!("{provider}/{model}"))),
		ContentBlock::ThinkingChange { level } => pieces.push(note("Thinking", level.clone())),
		ContentBlock::ModeChange { mode } => pieces.push(note("Mode", mode_words(mode))),
		ContentBlock::Lifecycle { phase, reason } => pieces.push(note(
			"Lifecycle",
			reason.as_ref().map_or_else(|| phase.clone(), |reason| format!("{phase}: {reason}")),
		)),
		ContentBlock::Summary { kind, text } => {
			let label = match entry.role {
				MessageRole::BranchSummary => "Branch summary",
				MessageRole::CompactionSummary => "Compaction summary",
				_ => "Summary",
			};
			pieces.push(Piece::Note { label: label.to_owned(), text: format!("{kind}: {text}"), boundary: true });
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

#[expect(clippy::too_many_arguments, reason = "one call site; the arguments are the row's inputs")]
fn tool_row(
	app: &AppState,
	session: &SessionId,
	entry: &TranscriptEntry,
	turn: Option<&TurnSpan>,
	live: bool,
	opened: &Opened<'_>,
	call_id: &str,
	name: &str,
	arguments: &serde_json::Value,
	call_view: Option<&Arc<ToolPresentation>>,
) -> ToolRow {
	let answer = turn.and_then(|turn| turn.result_of(call_id)).and_then(|ix| app.entry_at(session, ix)).and_then(|result| {
		result.content.iter().find_map(|block| match block {
			ContentBlock::ToolResult { tool, content, is_error, presentation } if tool == call_id => {
				Some((result.timestamp_ms, content, *is_error, presentation.as_ref()))
			},
			_ => None,
		})
	});
	let status = match answer {
		Some((_, _, true, _)) => ViewStatus::Error,
		Some(_) => ViewStatus::Success,
		None if live => ViewStatus::Running,
		None => ViewStatus::Aborted,
	};
	let result_view = answer.and_then(|(_, _, _, view)| view);
	let default_open = result_view.or(call_view).is_some_and(|view| view.expanded);
	let open = opened.tools.get(call_id).copied().unwrap_or(default_open);
	let body = open.then(|| match (result_view, answer) {
		(Some(view), _) => ToolBody::View(Arc::clone(view)),
		(None, Some((_, content, is_error, _))) => ToolBody::Lines(result_lines(content, is_error)),
		(None, None) => call_view.map_or_else(|| ToolBody::Lines(Vec::new()), |view| ToolBody::View(Arc::clone(view))),
	});
	ToolRow {
		call_id: call_id.to_owned(),
		verb: verb_of(name),
		target: target_of(arguments),
		status,
		duration_ms: answer.map(|(at, ..)| at.saturating_sub(entry.timestamp_ms)),
		open,
		body,
	}
}

fn role_label(entry: &TranscriptEntry) -> Option<&'static str> {
	match entry.role {
		MessageRole::User | MessageRole::Assistant => None,
		MessageRole::Developer => Some("Developer"),
		MessageRole::Custom => Some(match entry.raw_discriminator.as_str() {
			"side_question" => "Side question",
			"side_answer" => "Side answer",
			_ => "Custom",
		}),
		MessageRole::ToolResult => Some("Tool result"),
		MessageRole::BashExecution => Some("Shell execution"),
		MessageRole::PythonExecution => Some("Python execution"),
		MessageRole::BranchSummary => Some("Branch summary"),
		MessageRole::CompactionSummary => Some("Compaction summary"),
		MessageRole::FileMention => Some("File"),
		MessageRole::Lifecycle => Some("Lifecycle"),
		MessageRole::Unknown => Some("Unknown"),
	}
}

fn note(label: &str, text: String) -> Piece {
	Piece::Note { label: label.to_owned(), text, boundary: false }
}

/// The words a recorded mode reads as: `none` is `off`, separators open out.
#[must_use]
pub fn mode_words(mode: &str) -> String {
	match mode {
		"none" => "off".to_owned(),
		other => other.replace(['_', '-'], " "),
	}
}

fn video_words(media_type: &str, bytes: u64) -> String {
	format!("[video {media_type}, {}]", human_bytes(bytes))
}

/// `512 B`, `12.3 KB`, `4.0 MB`.
#[must_use]
pub fn human_bytes(bytes: u64) -> String {
	const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
	if bytes < 1024 {
		return format!("{bytes} B");
	}
	let mut value = bytes;
	let mut unit = UNITS.iter();
	let mut name = unit.next().copied().unwrap_or("KB");
	while value >= 1024 * 1024 {
		let Some(next) = unit.next() else { break };
		value /= 1024;
		name = next;
	}
	let tenths = value * 10 / 1024;
	format!("{}.{} {name}", tenths / 10, tenths % 10)
}

/// The words copying an entry takes: its prose, its thoughts, the calls it
/// made, what its runs printed and what its views state, in order.
#[must_use]
pub fn copy_text(entry: &TranscriptEntry) -> String {
	let mut out = String::new();
	for block in &entry.content {
		match block {
			ContentBlock::Text { text } | ContentBlock::Thinking { text } | ContentBlock::Diff { raw: text } => {
				push_line(&mut out, text);
			},
			ContentBlock::ToolCall { name, arguments, .. } => {
				let target = target_of(arguments).unwrap_or_default();
				push_line(&mut out, &format!("{} {target}", verb_of(name)));
			},
			ContentBlock::ToolResult { content, is_error, .. } => {
				push_line(&mut out, &result_lines(content, *is_error).join("\n"));
			},
			ContentBlock::Execution { command, output, .. } => {
				if let Some(command) = command {
					push_line(&mut out, command);
				}
				push_line(&mut out, &super::values::sanitize(output));
			},
			ContentBlock::Custom { view, .. } => {
				for row in view_rows(view) {
					push_line(&mut out, &row);
				}
			},
			ContentBlock::Summary { text, .. } => push_line(&mut out, text),
			ContentBlock::FileMention { path, .. } => push_line(&mut out, path),
			_ => {},
		}
	}
	out
}

fn push_line(out: &mut String, line: &str) {
	if !out.is_empty() {
		out.push('\n');
	}
	out.push_str(line);
}
