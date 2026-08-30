//! Composer view-model: the input surface's state.
//!
//! Mirrors `@veyyon/wire/presentation/composer`. The composer owns its own text
//! while the operator types; this is what the session tells it to show.

use serde::{Deserialize, Serialize};

use crate::transcript::Attachment;

/// What the composer is currently accepting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComposerMode {
	Input,
	Disabled,
	AwaitingApproval,
	Shell,
	Search,
}

/// One completion candidate offered under the cursor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCandidate {
	/// Text inserted when the candidate is accepted.
	pub value:  String,
	/// Text shown in the list, when it differs from `value`.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub label:  Option<String>,
	/// Secondary text shown beside the label.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub detail: Option<String>,
}

/// The completion popup, absent when nothing is offered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionState {
	/// Source token the candidates were derived from.
	pub prefix:         String,
	pub candidates:     Vec<CompletionCandidate>,
	/// Index into `candidates`; `-1` when nothing is highlighted.
	pub selected_index: i32,
}

impl CompletionState {
	/// The highlighted candidate, or `None` when the index is the sentinel or
	/// out of range.
	///
	/// A `-1` sentinel crossing a language boundary is exactly the kind of value
	/// that gets indexed with by accident, so the bound is checked here once
	/// rather than at each call site.
	pub fn selected(&self) -> Option<&CompletionCandidate> {
		usize::try_from(self.selected_index)
			.ok()
			.and_then(|index| self.candidates.get(index))
	}
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerState {
	pub mode:            ComposerMode,
	/// Current text. The renderer owns the cursor within it.
	pub text:            String,
	/// Cursor offset in UTF-16 code units.
	pub cursor_offset:   u32,
	/// Placeholder shown while `text` is empty.
	pub placeholder:     String,
	pub attachments:     Vec<Attachment>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub completion:      Option<CompletionState>,
	/// True when the session will queue a submit rather than run it now.
	pub queue_on_submit: bool,
	/// Hint line under the input, absent when there is nothing to say.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub hint:            Option<String>,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_composer_deserializes_from_the_wire_shape() {
		let json = r#"{
			"mode": "awaiting-approval",
			"text": "read src/",
			"cursorOffset": 9,
			"placeholder": "Ask anything",
			"attachments": [],
			"queueOnSubmit": true,
			"completion": {
				"prefix": "src/",
				"candidates": [{ "value": "src/main.rs", "detail": "120 B" }],
				"selectedIndex": 0
			}
		}"#;
		let state: ComposerState = serde_json::from_str(json).expect("deserializes");
		assert_eq!(state.mode, ComposerMode::AwaitingApproval);
		assert_eq!(state.cursor_offset, 9);
		assert!(state.queue_on_submit);
		assert_eq!(state.hint, None);
		let completion = state.completion.as_ref().expect("present");
		assert_eq!(completion.selected().map(|c| c.value.as_str()), Some("src/main.rs"));
		assert_eq!(completion.candidates[0].label, None);
	}

	/// The `-1` sentinel means nothing is highlighted, and it must not index.
	/// This is the value a renderer would otherwise cast and use.
	#[test]
	fn the_sentinel_index_selects_nothing() {
		let mut completion = CompletionState {
			prefix:         "s".into(),
			candidates:     vec![CompletionCandidate {
				value:  "src".into(),
				label:  None,
				detail: None,
			}],
			selected_index: -1,
		};
		assert!(completion.selected().is_none());

		// And an index past the end selects nothing rather than panicking.
		completion.selected_index = 7;
		assert!(completion.selected().is_none());

		completion.selected_index = 0;
		assert!(completion.selected().is_some());
	}

	/// Every mode round-trips. A mode that arrives unrecognised would leave the
	/// composer in whatever state it was, accepting input it should refuse.
	#[test]
	fn every_composer_mode_round_trips() {
		for (mode, wire) in [
			(ComposerMode::Input, "input"),
			(ComposerMode::Disabled, "disabled"),
			(ComposerMode::AwaitingApproval, "awaiting-approval"),
			(ComposerMode::Shell, "shell"),
			(ComposerMode::Search, "search"),
		] {
			assert_eq!(serde_json::to_string(&mode).unwrap(), format!("\"{wire}\""));
			let back: ComposerMode =
				serde_json::from_str(&format!("\"{wire}\"")).expect("deserializes");
			assert_eq!(back, mode);
		}
	}
}
