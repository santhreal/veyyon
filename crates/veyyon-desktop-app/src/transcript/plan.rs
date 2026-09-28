//! What one transcript item draws, read out of the store before anything is
//! drawn.
//!
//! Reading and drawing are split so an item is planned while the store is
//! borrowed and drawn afterwards with the window free: the plan holds owned,
//! bounded data (a tool's output only when its row is open, a presentation as
//! a shared pointer) and never the entry itself.

use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use veyyon_desktop_model::{
	ContentBlock, EntryId, MessageRole, SessionId, TranscriptEntry,
	tool_view::{ToolPresentation, ToolView, ViewStatus, view_rows},
};

use super::{
	blocks::{plan_block, plan_operator},
	turn::{TurnIndex, TurnSpan, is_answer},
	values::{result_lines, target_of, verb_of},
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
	let folded =
		turn.is_some_and(|turn| !live && turn.steps > 0 && !opened.turns.contains(&turn.range.start));
	for (block_ix, block) in entry.content.iter().enumerate() {
		if let ContentBlock::ToolCall { id, name, arguments, presentation } = block {
			if let Some(turn) = turn
				&& turn.first_tool == Some(ix)
				&& !live && turn.steps > 0
				&& first_call(entry) == Some(block_ix)
			{
				plan.pieces.push(Piece::Worked {
					anchor: turn.range.start,
					text:   turn.summary(),
					open:   !folded,
				});
			}
			if folded {
				continue;
			}
			let row = tool_row(
				app,
				session,
				entry,
				turn,
				live,
				opened,
				id,
				name,
				arguments,
				presentation.as_ref(),
			);
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
	entry
		.content
		.iter()
		.position(|block| matches!(block, ContentBlock::ToolCall { .. }))
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
	let answer = turn
		.and_then(|turn| turn.result_of(call_id))
		.and_then(|ix| app.entry_at(session, ix))
		.and_then(|result| {
			result.content.iter().find_map(|block| match block {
				ContentBlock::ToolResult { tool, content, is_error, presentation }
					if tool == call_id =>
				{
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
		(None, None) => call_view
			.map_or_else(|| ToolBody::Lines(Vec::new()), |view| ToolBody::View(Arc::clone(view))),
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

/// The words copying an entry takes: its prose, its thoughts, the calls it
/// made, what its runs printed and what its views state, in order.
#[must_use]
pub fn copy_text(entry: &TranscriptEntry) -> String {
	let mut out = String::new();
	for block in &entry.content {
		match block {
			ContentBlock::Text { text }
			| ContentBlock::Thinking { text }
			| ContentBlock::Diff { raw: text } => {
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

pub(super) fn push_line(out: &mut String, line: &str) {
	if !out.is_empty() {
		out.push('\n');
	}
	out.push_str(line);
}
