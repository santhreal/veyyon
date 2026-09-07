//! In-transcript search logic and match navigation (§5.2, §5.3, §5.14).
//!
//! Provides case-insensitive substring matching across operator turns and
//! assistant prose, reasoning, tool invocations, and mono panes, with
//! next/previous match cycling and viewport scroll targeting.

use std::time::Instant;

use veyyon_desktop_kit::input::Editor;
use veyyon_desktop_motion::MotionTokens;
use veyyon_gpui::Entity;

use super::state::TranscriptViewportState;
use crate::model::{Artifact, Block, Turn};

/// Target block kind for expanding matching assistant content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchTarget {
	/// Match is in the top-level operator prompt turn.
	OperatorTurn,
	/// Match is in a recorded operator attachment or file reference.
	OperatorArtifact(usize),
	/// Match is in an assistant prose, reasoning, or tool invocation block.
	AssistantBlock(usize),
	/// Match is in an assistant mono pane block.
	AssistantPane(usize),
}

/// One search hit in the transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptFindMatch {
	/// Zero-based turn index containing the match.
	pub turn_ix: usize,
	/// Target location within the turn.
	pub target:  MatchTarget,
	/// Matching excerpt or surrounding snippet.
	pub snippet: String,
}

/// Retained state for the in-transcript find workflow.
#[derive(Default)]
pub struct TranscriptFindState {
	/// Active search query string.
	pub query:           String,
	/// Matching turn and block locations.
	pub matches:         Vec<TranscriptFindMatch>,
	/// Currently selected match index (0-based).
	pub active_match_ix: Option<usize>,
	/// Interactive single-line editor handle.
	pub editor:          Option<Entity<Editor>>,
}

impl TranscriptFindState {
	/// Creates a new empty find state.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Returns whether any search query is actively set.
	#[must_use]
	pub fn has_query(&self) -> bool {
		!self.query.trim().is_empty()
	}

	/// Returns the number of matching blocks found.
	#[must_use]
	pub const fn match_count(&self) -> usize {
		self.matches.len()
	}

	/// Returns the 1-based index of the currently active match, or 0 if none.
	#[must_use]
	pub fn current_match_number(&self) -> usize {
		self.active_match_ix.map_or(0, |ix| ix + 1)
	}

	/// Returns the currently active match, if any.
	#[must_use]
	pub fn active_match(&self) -> Option<&TranscriptFindMatch> {
		self.active_match_ix.and_then(|ix| self.matches.get(ix))
	}

	/// Updates the search query and recomputes all matching locations across
	/// `turns`.
	pub fn set_query(&mut self, query: &str, turns: &[Turn]) {
		query.clone_into(&mut self.query);
		let trimmed = query.trim().to_lowercase();
		if trimmed.is_empty() {
			self.matches.clear();
			self.active_match_ix = None;
			return;
		}

		let mut hits = Vec::new();
		for (turn_ix, turn) in turns.iter().enumerate() {
			match turn {
				Turn::Operator(text) => {
					if text.to_lowercase().contains(&trimmed) {
						hits.push(TranscriptFindMatch {
							turn_ix,
							target: MatchTarget::OperatorTurn,
							snippet: text.clone(),
						});
					}
				},
				Turn::OperatorArtifacts { text, artifacts } => {
					if text.to_lowercase().contains(&trimmed) {
						hits.push(TranscriptFindMatch {
							turn_ix,
							target: MatchTarget::OperatorTurn,
							snippet: text.clone(),
						});
					}
					for (block_ix, artifact) in artifacts.iter().enumerate() {
						let snippet = artifact_search_text(artifact);
						if snippet.to_lowercase().contains(&trimmed) {
							hits.push(TranscriptFindMatch {
								turn_ix,
								target: MatchTarget::OperatorArtifact(block_ix),
								snippet,
							});
						}
					}
				},
				Turn::Agent(blocks) => {
					for (block_ix, block) in blocks.iter().enumerate() {
						match block {
							Block::Artifact(artifact) => {
								let snippet = artifact_search_text(artifact);
								if snippet.to_lowercase().contains(&trimmed) {
									hits.push(TranscriptFindMatch {
										turn_ix,
										target: MatchTarget::AssistantBlock(block_ix),
										snippet,
									});
								}
							},
							Block::Prose(text) => {
								if text.to_lowercase().contains(&trimmed) {
									hits.push(TranscriptFindMatch {
										turn_ix,
										target: MatchTarget::AssistantBlock(block_ix),
										snippet: text.clone(),
									});
								}
							},
							Block::Note { label, text, .. } => {
								if label.to_lowercase().contains(&trimmed)
									|| text.to_lowercase().contains(&trimmed)
								{
									hits.push(TranscriptFindMatch {
										turn_ix,
										target: MatchTarget::AssistantBlock(block_ix),
										snippet: format!("{label}: {text}"),
									});
								}
							},
							Block::Reason(summary) => {
								if summary.to_lowercase().contains(&trimmed) {
									hits.push(TranscriptFindMatch {
										turn_ix,
										target: MatchTarget::AssistantBlock(block_ix),
										snippet: summary.clone(),
									});
								}
							},
							Block::Invoke { tool, target, result, .. } => {
								if tool.to_lowercase().contains(&trimmed)
									|| target.to_lowercase().contains(&trimmed)
									|| result
										.as_ref()
										.is_some_and(|r| r.to_lowercase().contains(&trimmed))
								{
									hits.push(TranscriptFindMatch {
										turn_ix,
										target: MatchTarget::AssistantBlock(block_ix),
										snippet: tool.clone(),
									});
								}
							},
							Block::Pane { caption, lines }
							| Block::Unknown { producer: caption, lines } => {
								if caption.to_lowercase().contains(&trimmed)
									|| lines.iter().any(|l| l.to_lowercase().contains(&trimmed))
								{
									hits.push(TranscriptFindMatch {
										turn_ix,
										target: MatchTarget::AssistantPane(block_ix),
										snippet: caption.clone(),
									});
								}
							},
						}
					}
				},
			}
		}

		self.matches = hits;
		if self.matches.is_empty() {
			self.active_match_ix = None;
		} else {
			self.active_match_ix = Some(0);
		}
	}

	/// Scrolls the viewport to the active match and expands its enclosing block
	/// or pane.
	pub fn reveal_active_match(
		&self,
		viewport: &TranscriptViewportState,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		let Some(m) = self.active_match() else {
			return;
		};
		viewport.scroll_to_turn_animated(m.turn_ix, tokens, reduced, now);
		match m.target {
			MatchTarget::OperatorTurn => {},
			MatchTarget::AssistantBlock(block_ix)
			| MatchTarget::AssistantPane(block_ix)
			| MatchTarget::OperatorArtifact(block_ix) => {
				viewport.set_block_expanded(m.turn_ix, block_ix, true, tokens, reduced, now);
			},
		}
	}

	/// Updates the query and immediately reveals the first matching block.
	pub fn set_query_and_reveal(
		&mut self,
		query: &str,
		turns: &[Turn],
		viewport: &TranscriptViewportState,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		self.set_query(query, turns);
		self.reveal_active_match(viewport, tokens, reduced, now);
	}

	/// Synchronizes active matches against incoming turn updates or session
	/// switches.
	pub fn sync_turns(&mut self, turns: &[Turn]) {
		if self.query.trim().is_empty() {
			self.matches.clear();
			self.active_match_ix = None;
			return;
		}
		let old_active = self.active_match_ix;
		self.set_query(&self.query.clone(), turns);
		if let Some(old) = old_active
			&& !self.matches.is_empty()
		{
			self.active_match_ix = Some(old.min(self.matches.len() - 1));
		}
	}

	/// Advances to the next matching hit, scrolling the viewport and expanding
	/// any closed block.
	pub fn next_match(
		&mut self,
		viewport: &TranscriptViewportState,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		if self.matches.is_empty() {
			return;
		}
		let next = self
			.active_match_ix
			.map_or(0, |cur| (cur + 1) % self.matches.len());
		self.active_match_ix = Some(next);
		self.reveal_active_match(viewport, tokens, reduced, now);
	}

	/// Jumps to the previous matching hit, scrolling the viewport and expanding
	/// any closed block.
	pub fn prev_match(
		&mut self,
		viewport: &TranscriptViewportState,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		if self.matches.is_empty() {
			return;
		}
		let count = self.matches.len();
		let prev = self.active_match_ix.map_or_else(
			|| count.saturating_sub(1),
			|cur| {
				if cur == 0 {
					count.saturating_sub(1)
				} else {
					cur - 1
				}
			},
		);
		self.active_match_ix = Some(prev);
		self.reveal_active_match(viewport, tokens, reduced, now);
	}

	/// Clears the search state and active matches.
	pub fn clear(&mut self) {
		self.query.clear();
		self.matches.clear();
		self.active_match_ix = None;
	}
}

fn artifact_search_text(artifact: &Artifact) -> String {
	match artifact {
		Artifact::Image { media_type, alt, .. } => match alt {
			Some(alt) => format!("{alt} ({media_type})"),
			None => format!("Image ({media_type})"),
		},
		Artifact::File { path, unavailable_reason, .. } => match unavailable_reason {
			Some(reason) => format!("{path}: {reason}"),
			None => path.clone(),
		},
	}
}
