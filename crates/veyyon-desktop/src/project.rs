//! From what the host reported to what the surfaces draw.
//!
//! `Store` holds the protocol model: every session the host listed, the
//! transcript tree with its branches, the interactions waiting on an answer.
//! `ShellState` holds what one render shows: sections of rows, a linear run of
//! turns, a stack of cards. This module is the one place the first becomes the
//! second, and the one place an operator's intent becomes a `HostAction`.
//!
//! The projection overwrites only the fields the host owns. What the window
//! owns — the composer's text, the drawer, the panel's tab — is left as it is,
//! so a frame arriving mid-keystroke does not take the keystroke away.

use std::{collections::HashMap, fmt::Write as _};

use serde_json::{Value, json};
use veyyon_desktop_model::{
	ContentBlock, HostAction, InteractionId, MessageRole, PendingDecisions, QueuePartition, Session,
	SessionBadge, SessionId, Store, TranscriptEntry, TranscriptTree,
};
use veyyon_desktop_surface::{Badge, Block, Card, Intent, Row, Section, ShellState, Turn};

/// How many lines a mono pane keeps before the rest is counted, not shown.
///
/// A command's output can run to the tens of thousands of lines, and a
/// transcript that holds all of them draws none of them in time.
pub const PANE_LINE_CEILING: usize = 200;

/// Row identities for sessions.
///
/// A queue row is keyed by a `u64` so a click survives the queue re-sorting
/// under it; a session is keyed by the host's string id. This maps between the
/// two, and a session keeps its row id for the life of the window, so a row
/// that moved from Live to Deferred is still the row that was selected.
#[derive(Debug, Default)]
pub struct SessionIndex {
	rows:     HashMap<SessionId, u64>,
	sessions: Vec<SessionId>,
}

impl SessionIndex {
	/// An empty index.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// The row id for a session, minted on first sight. Row ids start at one;
	/// zero is the id of no session.
	pub fn row_of(&mut self, session: &SessionId) -> u64 {
		if let Some(row) = self.rows.get(session) {
			return *row;
		}
		self.sessions.push(session.clone());
		let row = self.sessions.len() as u64;
		self.rows.insert(session.clone(), row);
		row
	}

	/// The session a row id stands for, if one was minted for it.
	#[must_use]
	pub fn session_of(&self, row: u64) -> Option<&SessionId> {
		let index = usize::try_from(row.checked_sub(1)?).ok()?;
		self.sessions.get(index)
	}
}

/// Projects the store onto the shell state's host-owned fields.
///
/// `now_ms` is the clock the elapsed labels are measured against; it is passed
/// in so a test can pin it.
pub fn project(store: &Store, index: &mut SessionIndex, now_ms: u64, state: &mut ShellState) {
	let active = store.persisted.shell.active_session.as_ref();

	state.sections = QueuePartition::ALL
		.iter()
		.filter_map(|partition| {
			let ids = partition_ids(store, *partition);
			if ids.is_empty() {
				return None;
			}
			let rows = ids
				.iter()
				.filter_map(|id| store.sessions.get(id))
				.map(|session| row(session, index.row_of(&session.id), now_ms))
				.collect();
			Some((section(*partition), rows))
		})
		.collect();

	let active_session = active.and_then(|id| store.sessions.get(id));
	state.current_id = active.map_or(0, |id| index.row_of(id));
	state.title = active_session.map_or_else(|| "veyyon".to_string(), |s| s.title.clone());

	state.transcript = active
		.and_then(|id| store.transcripts.get(id))
		.map(turns)
		.unwrap_or_default();

	let streaming = active.and_then(|id| store.streaming.get(id));
	if let Some(stream) = streaming {
		push_entry(&mut state.transcript, &stream.accumulating);
	}

	state.run_status = match streaming {
		Some(stream) => Some((
			Badge::Working,
			stream
				.tool
				.as_ref()
				.map_or_else(|| "Working".to_string(), |tool| format!("Working · {tool}")),
		)),
		None => active_session.and_then(|s| s.badge.as_ref()).map(|b| {
			let badge = badge(b);
			(badge, badge.label().to_string())
		}),
	};

	state.cards = active
		.and_then(|id| store.interactions.get(id))
		.map(cards)
		.unwrap_or_default();
}

/// The session ids in a partition, in the collection's order.
fn partition_ids(store: &Store, partition: QueuePartition) -> &[SessionId] {
	let sessions = &store.sessions;
	match partition {
		QueuePartition::Unsent => &sessions.unsent,
		QueuePartition::Pinned => &sessions.pinned,
		QueuePartition::Live => &sessions.live,
		QueuePartition::Deferred => &sessions.deferred,
		QueuePartition::Parked => &sessions.parked,
	}
}

const fn section(partition: QueuePartition) -> Section {
	match partition {
		QueuePartition::Unsent => Section::Unsent,
		QueuePartition::Pinned => Section::Pinned,
		QueuePartition::Live => Section::Live,
		QueuePartition::Deferred => Section::Deferred,
		QueuePartition::Parked => Section::Parked,
	}
}

const fn badge(badge: &SessionBadge) -> Badge {
	match badge {
		SessionBadge::Approval => Badge::Approval,
		SessionBadge::Input => Badge::Input,
		SessionBadge::Plan => Badge::Plan,
		SessionBadge::Failed => Badge::Failed,
		SessionBadge::Due => Badge::Due,
		SessionBadge::Done => Badge::Done,
		SessionBadge::Working { .. } => Badge::Working,
		SessionBadge::Watching => Badge::Watching,
	}
}

fn row(session: &Session, id: u64, now_ms: u64) -> Row {
	let subtitle = if session.branch.is_empty() {
		session.project_name.clone()
	} else {
		format!("{} · {}", session.project_name, session.branch)
	};
	let meta = match (&session.badge, session.defer_until_ms) {
		(Some(SessionBadge::Working { started_at_ms }), _) => {
			Some(elapsed_label(now_ms.saturating_sub(*started_at_ms)))
		},
		(_, Some(due_at_ms)) if due_at_ms > now_ms => {
			Some(format!("in {}", elapsed_label(due_at_ms - now_ms)))
		},
		_ => Some(elapsed_label(now_ms.saturating_sub(session.last_recall_at_ms))),
	};
	Row {
		id,
		title: session.title.clone(),
		subtitle,
		badge: session.badge.as_ref().map(badge),
		meta,
	}
}

/// A duration as the queue shows it: the largest unit that is at least one.
#[must_use]
pub fn elapsed_label(ms: u64) -> String {
	const MINUTE: u64 = 60_000;
	const HOUR: u64 = 60 * MINUTE;
	const DAY: u64 = 24 * HOUR;
	if ms >= DAY {
		format!("{}d", ms / DAY)
	} else if ms >= HOUR {
		format!("{}h", ms / HOUR)
	} else if ms >= MINUTE {
		format!("{}m", ms / MINUTE)
	} else {
		format!("{}s", ms / 1000)
	}
}

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
fn turns(tree: &TranscriptTree) -> Vec<Turn> {
	let mut turns = Vec::new();
	for entry in active_path(tree) {
		push_entry(&mut turns, entry);
	}
	turns
}

/// Appends an entry to the run of turns, merging agent output into the open
/// agent turn.
fn push_entry(turns: &mut Vec<Turn>, entry: &TranscriptEntry) {
	if entry.role == MessageRole::User {
		let text = entry
			.content
			.iter()
			.filter_map(|block| match block {
				ContentBlock::Text { text } => Some(text.as_str().to_string()),
				ContentBlock::FileMention { path, .. } => Some(format!("@{path}")),
				ContentBlock::Image { alt, media_type, .. } => Some(
					alt.clone()
						.unwrap_or_else(|| format!("[image {media_type}]")),
				),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n");
		turns.push(Turn::Operator(text));
		return;
	}

	if !matches!(turns.last(), Some(Turn::Agent(_))) {
		turns.push(Turn::Agent(Vec::new()));
	}
	if let Some(Turn::Agent(blocks)) = turns.last_mut() {
		for block in &entry.content {
			push_block(blocks, block);
		}
	}
}

fn push_block(blocks: &mut Vec<Block>, block: &ContentBlock) {
	match block {
		ContentBlock::Text { text } => blocks.push(Block::Prose(text.clone())),
		ContentBlock::Thinking { text } => blocks.push(Block::Reason(text.clone())),
		ContentBlock::RedactedThinking { marker } => {
			blocks.push(Block::Reason(format!("redacted ({marker})")));
		},
		ContentBlock::ToolCall { name, arguments, .. } => blocks.push(Block::Invoke {
			tool:   name.clone(),
			target: target_of(arguments),
			result: None,
		}),
		ContentBlock::ToolResult { tool, content, is_error } => {
			let outcome = first_line(content, *is_error);
			let open = blocks.iter_mut().rev().find_map(|block| match block {
				Block::Invoke { tool: called, result, .. } if result.is_none() && called == tool => {
					Some(result)
				},
				_ => None,
			});
			match open {
				Some(result) => *result = Some(outcome),
				None => blocks.push(Block::Pane {
					caption: tool.clone(),
					lines:   pane_lines(&value_text(content)),
				}),
			}
		},
		ContentBlock::Execution { language, command, output, exit_code } => {
			let mut caption = command.clone().unwrap_or_else(|| language.clone());
			if let Some(code) = exit_code
				&& *code != 0
			{
				let _ = write!(caption, " · exit {code}");
			}
			blocks.push(Block::Pane { caption, lines: pane_lines(output) });
		},
		ContentBlock::FileMention { path, .. } => blocks.push(Block::Prose(format!("@{path}"))),
		ContentBlock::Diff { raw } => {
			blocks.push(Block::Pane { caption: "diff".to_string(), lines: pane_lines(raw) });
		},
		ContentBlock::ModelChange { provider, model } => {
			blocks.push(Block::Prose(format!("model: {provider}/{model}")));
		},
		ContentBlock::ThinkingChange { level } => {
			blocks.push(Block::Prose(format!("thinking: {level}")));
		},
		ContentBlock::Lifecycle { phase, reason } => blocks.push(Block::Prose(match reason {
			Some(reason) => format!("{phase}: {reason}"),
			None => phase.clone(),
		})),
		ContentBlock::Summary { kind, text } => {
			blocks.push(Block::Pane { caption: kind.clone(), lines: pane_lines(text) });
		},
		ContentBlock::Image { alt, media_type, .. } => blocks.push(Block::Prose(
			alt.clone()
				.unwrap_or_else(|| format!("[image {media_type}]")),
		)),
		ContentBlock::Fallback { producer, .. } => {
			blocks.push(Block::Prose(format!("[{producer}]")));
		},
		ContentBlock::Unknown { tag, .. } => blocks.push(Block::Prose(format!("[{tag}]"))),
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

fn first_line(value: &Value, is_error: bool) -> String {
	let text = value_text(value);
	let line = text.lines().next().unwrap_or_default();
	if is_error {
		format!("error: {line}")
	} else {
		line.to_string()
	}
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

/// The cards for a session's pending decisions: approvals, then questions,
/// then plans. `interaction_at` reads the same order, so a card's position is
/// its interaction's.
fn cards(pending: &PendingDecisions) -> Vec<Card> {
	let mut cards =
		Vec::with_capacity(pending.approvals.len() + pending.questions.len() + pending.plans.len());
	cards.extend(pending.approvals.iter().map(|a| Card::Approval {
		tool:   a.tool_name.clone(),
		detail: a.detail.lines().map(str::to_string).collect(),
	}));
	cards.extend(
		pending
			.questions
			.iter()
			.map(|q| Card::Question { prompt: q.prompt.clone(), options: q.options.clone() }),
	);
	cards.extend(pending.plans.iter().map(|p| {
		let mut lines = p.markdown_plan.lines();
		let title = lines
			.next()
			.unwrap_or_default()
			.trim_start_matches('#')
			.trim()
			.to_string();
		Card::Plan { title, body: lines.map(str::to_string).collect() }
	}));
	cards
}

/// Removes and returns the interaction at a card position, with the answer
/// the host expects for it.
///
/// The card was removed from the shell state when the intent was applied, so
/// the store's copy is removed here to keep the two stacks aligned for the
/// next card answered before the host confirms this one.
fn take_interaction(
	pending: &mut PendingDecisions,
	card: usize,
	answer: &Intent,
) -> Option<(InteractionId, Value)> {
	let approvals = pending.approvals.len();
	let questions = pending.questions.len();
	match *answer {
		Intent::Approval { approved, .. } if card < approvals => {
			let approval = pending.approvals.remove(card);
			Some((approval.id, json!({ "approved": approved })))
		},
		Intent::Answer { option, .. } if (approvals..approvals + questions).contains(&card) => {
			let question = pending.questions.remove(card - approvals);
			let text = question.options.get(option)?.clone();
			Some((question.id, json!({ "option": option, "text": text })))
		},
		Intent::Plan { accepted, .. }
			if card >= approvals + questions && card - approvals - questions < pending.plans.len() =>
		{
			let plan = pending.plans.remove(card - approvals - questions);
			Some((plan.id, json!({ "accepted": accepted })))
		},
		_ => None,
	}
}

/// The host action an intent asks for, or `None` for one the shell finished
/// alone or one that no longer has a target.
///
/// `store` is mutated only for a decision, whose pending interaction is taken
/// out so the next card's position still means the next card.
pub fn action_for(intent: &Intent, index: &SessionIndex, store: &mut Store) -> Option<HostAction> {
	let active = store.persisted.shell.active_session.clone();
	match intent {
		Intent::SelectSession(row) => {
			Some(HostAction::OpenSession { session: index.session_of(*row)?.clone() })
		},
		Intent::Send(text) => Some(HostAction::SubmitPrompt {
			session:     active?,
			text:        text.clone(),
			attachments: Vec::new(),
		}),
		Intent::Approval { card, .. } | Intent::Answer { card, .. } | Intent::Plan { card, .. } => {
			let session = active?;
			let pending = store.interactions.get_mut(&session)?;
			let (id, response) = take_interaction(pending, *card, intent)?;
			Some(HostAction::RespondToInteraction { session, interaction_id: id.0, response })
		},
		Intent::SelectTab(_) | Intent::ToggleDrawer => None,
	}
}
