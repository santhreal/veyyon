//! The turns a transcript's flat display order reads as.
//!
//! One operator entry opens a turn; everything after it up to the next
//! operator entry is what came back. A finished turn folds its tool rows into
//! one `Worked for 42s · 12 steps` row, so each list item needs to know which
//! turn it sits in, whether it is the turn's first tool item and which later
//! entry answered each call. The index holds that per turn and is rebuilt from
//! the turn a splice touched, so an entry arriving costs the turn it lands in
//! and never the whole transcript.

use std::ops::Range;

use veyyon_desktop_model::{ContentBlock, MessageRole, SessionId, TranscriptEntry};

use crate::AppState;

/// One turn of the display order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnSpan {
	/// The display indices the turn covers.
	pub range:      Range<usize>,
	/// The first item that carries a tool call.
	pub first_tool: Option<usize>,
	/// The tool calls the turn made.
	pub steps:      usize,
	/// When the turn's first entry was recorded, epoch milliseconds.
	pub started_ms: u64,
	/// When the turn's last entry was recorded, epoch milliseconds.
	pub ended_ms:   u64,
	/// Each call id answered in this turn and the index of the entry that
	/// answered it.
	pub results:    Vec<(String, usize)>,
	/// The ids of the calls the turn made.
	pub calls:      Vec<String>,
}

impl TurnSpan {
	/// The index of the entry holding the result of call `call_id`.
	#[must_use]
	pub fn result_of(&self, call_id: &str) -> Option<usize> {
		self
			.results
			.iter()
			.find(|(id, _)| id == call_id)
			.map(|(_, ix)| *ix)
	}

	/// What the folded row reads: `Worked for 42s · 12 steps`.
	#[must_use]
	pub fn summary(&self) -> String {
		let secs = self.ended_ms.saturating_sub(self.started_ms) / 1000;
		let steps = if self.steps == 1 {
			"1 step".to_owned()
		} else {
			format!("{} steps", self.steps)
		};
		format!("Worked for {} · {steps}", duration_words(secs))
	}
}

/// `42s`, `3m 12s`, `1h 4m`.
#[must_use]
pub fn duration_words(secs: u64) -> String {
	match secs {
		0..60 => format!("{secs}s"),
		60..3600 => format!("{}m {}s", secs / 60, secs % 60),
		_ => format!("{}h {}m", secs / 3600, (secs % 3600) / 60),
	}
}

/// The turns of one session's display order.
#[derive(Debug, Default)]
pub struct TurnIndex {
	turns: Vec<TurnSpan>,
}

impl TurnIndex {
	/// Reads every turn of `session` from scratch.
	pub fn rebuild(&mut self, app: &AppState, session: &SessionId) {
		self.turns.clear();
		self.scan_from(app, session, 0);
	}

	/// Brings the index up to date after items `range` of the previous order
	/// were replaced by `count` items, and returns the display range whose
	/// drawing depends on the change: the turn the splice landed in, from its
	/// start to the end of the order.
	pub fn splice(
		&mut self,
		app: &AppState,
		session: &SessionId,
		range: &Range<usize>,
	) -> Range<usize> {
		let keep = self
			.turns
			.partition_point(|turn| turn.range.end <= range.start);
		let start = self
			.turns
			.get(keep)
			.map_or(range.start, |turn| turn.range.start.min(range.start));
		self.turns.truncate(keep);
		self.scan_from(app, session, start);
		start..app.entry_count(session)
	}

	/// The turn display index `ix` sits in.
	#[must_use]
	pub fn turn_at(&self, ix: usize) -> Option<&TurnSpan> {
		let at = self.turns.partition_point(|turn| turn.range.end <= ix);
		self.turns.get(at).filter(|turn| turn.range.contains(&ix))
	}

	/// Whether the turn at `ix` is the last one.
	#[must_use]
	pub fn is_last(&self, ix: usize) -> bool {
		self
			.turns
			.last()
			.is_some_and(|turn| turn.range.contains(&ix))
	}

	/// The number of turns.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.turns.len()
	}

	/// Whether the order holds no turn.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.turns.is_empty()
	}

	fn scan_from(&mut self, app: &AppState, session: &SessionId, start: usize) {
		let count = app.entry_count(session);
		let mut open: Option<TurnSpan> = None;
		for ix in start..count {
			let Some(entry) = app.entry_at(session, ix) else {
				continue;
			};
			if entry.role == MessageRole::User || open.is_none() {
				self.turns.extend(open.take());
				open = Some(TurnSpan {
					range: ix..ix,
					started_ms: entry.timestamp_ms,
					..TurnSpan::default()
				});
			}
			if let Some(turn) = open.as_mut() {
				absorb(turn, ix, entry);
			}
		}
		self.turns.extend(open);
	}
}

fn absorb(turn: &mut TurnSpan, ix: usize, entry: &TranscriptEntry) {
	turn.range.end = ix + 1;
	turn.ended_ms = turn.ended_ms.max(entry.timestamp_ms);
	for block in &entry.content {
		match block {
			ContentBlock::ToolCall { id, .. } => {
				turn.steps += 1;
				turn.first_tool.get_or_insert(ix);
				turn.calls.push(id.clone());
			},
			ContentBlock::ToolResult { tool, .. } => {
				turn.results.push((tool.clone(), ix));
			},
			_ => {},
		}
	}
}

/// Whether `entry` is a tool result whose call is drawn by an earlier item of
/// `turn`, so the result draws inside the call's row rather than on its own.
#[must_use]
pub fn is_answer(turn: &TurnSpan, entry: &TranscriptEntry) -> bool {
	entry.role == MessageRole::ToolResult
		&& entry.content.iter().all(|block| match block {
			ContentBlock::ToolResult { tool, .. } => turn.calls.iter().any(|id| id == tool),
			_ => false,
		})
}
