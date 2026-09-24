//! Dictation domain types (§5, §8).

use serde::{Deserialize, Serialize};

/// Where a dictation is.
#[derive(
	Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter,
)]
#[serde(rename_all = "snake_case")]
pub enum DictationState {
	/// No microphone is open and nothing is being recognised.
	#[default]
	Idle,
	/// The microphone is open.
	Recording,
	/// The microphone is closed and the recogniser is finishing.
	Transcribing,
}

impl DictationState {
	/// Returns the stable string identifier matching the wire protocol.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Idle => "idle",
			Self::Recording => "recording",
			Self::Transcribing => "transcribing",
		}
	}

	/// The words the composer control is drawn with.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Idle => "Dictate",
			Self::Recording => "Recording",
			Self::Transcribing => "Transcribing",
		}
	}

	/// Whether a microphone is open or a recogniser is still running.
	#[must_use]
	pub const fn is_active(self) -> bool {
		matches!(self, Self::Recording | Self::Transcribing)
	}
}

/// Snapshot view of the speech this window is dictating.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DictationView {
	pub state:     DictationState,
	/// Everything this dictation has committed, trimmed of a spoken submit
	/// phrase. The composer writes it after the draft the dictation started on.
	pub utterance: String,
	/// The phrase still being said, which no draft holds until the recogniser
	/// commits it.
	pub partial:   String,
	/// The spoken submit phrase fired, so the composer sends what it holds.
	pub submit:    bool,
	/// What the dictation is doing that takes long enough to state; `None` when
	/// there is nothing to state.
	pub status:    Option<String>,
	/// Why the last dictation stopped short; `None` until one does.
	pub error:     Option<String>,
	/// Rises once per committed change, so the composer applies each one once.
	pub revision:  u64,
}

impl DictationView {
	/// Text the composer appends for this revision: the committed utterance
	/// and, while one is being said, the phrase in flight.
	///
	/// The preview is one string rather than two so the composer draws a
	/// sentence being spoken rather than a committed half and a loose tail.
	///
	/// The two are concatenated rather than joined. A phrase in flight already
	/// carries the separator it needs: the recogniser prefixes every segment
	/// after the first with a space, which is what the terminal composer
	/// inserts at its cursor, and the host sends that text unchanged. Joining
	/// on a space here drew two of them between every committed phrase and the
	/// one being said after it.
	#[must_use]
	pub fn preview(&self) -> String {
		match (self.utterance.is_empty(), self.partial.is_empty()) {
			(true, true) => String::new(),
			(false, true) => self.utterance.clone(),
			(true, false) => self.partial.clone(),
			(false, false) => format!("{}{}", self.utterance, self.partial),
		}
	}

	/// Whether this revision carries words the composer has not written yet.
	#[must_use]
	pub const fn has_utterance(&self) -> bool {
		!self.utterance.is_empty()
	}

	/// The words the composer chip is drawn with: the state, and what has been
	/// heard so far once there is any of it (§5.4).
	///
	/// Nothing is shed and nothing is truncated here. The footer holds this
	/// chip beside the model name and shortens it at the row, so a chip that
	/// also cut itself down would decide twice and disagree with the row it
	/// sits in.
	#[must_use]
	pub fn chip_text(&self) -> String {
		let label = self.state.label();
		let preview = self.preview();
		if preview.is_empty() {
			label.to_string()
		} else {
			format!("{label}: {preview}")
		}
	}
}
