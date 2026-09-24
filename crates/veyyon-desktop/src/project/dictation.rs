//! Where recognised speech lands in the composer (§5.4).
//!
//! Speech is recognised at the host, which holds no draft: a frame carries the
//! whole of what this dictation has committed, never the field it goes in. The
//! window keeps the draft the dictation started on and rewrites the field from
//! it on every frame, so a segment the recogniser revises replaces what it
//! revised rather than being appended twice.

use veyyon_desktop_model::{DictationState, DictationView};

/// What the window does with one dictation frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictationLanding {
	/// The whole draft the composer holds after this frame.
	pub draft:  String,
	/// The spoken submit phrase fired and the recogniser has finished, so the
	/// draft is sent.
	pub submit: bool,
}

/// The draft a dictation started on, and the last frame written from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DictationDraft {
	/// What the composer held when this dictation opened; `None` between
	/// dictations.
	base:    Option<String>,
	/// The highest revision already written to the field.
	applied: u64,
}

impl DictationDraft {
	/// Reads one frame against the drawn field.
	///
	/// Returns what the composer should hold, or `None` when the frame changes
	/// nothing: a revision already written, or an idle dictation that never
	/// captured a base.
	pub fn land(&mut self, view: &DictationView, drawn: &str) -> Option<DictationLanding> {
		if view.revision <= self.applied {
			return None;
		}
		self.applied = view.revision;
		let idle = view.state == DictationState::Idle;
		if view.utterance.is_empty() {
			// Nothing was committed. A dictation that was discarded or heard no
			// speech puts back the draft it opened on; one still running has
			// only a partial, which the chip states and the field does not hold.
			if idle {
				return self
					.base
					.take()
					.map(|draft| DictationLanding { draft, submit: false });
			}
			return None;
		}
		let base = self.base.get_or_insert_with(|| drawn.to_owned());
		let draft = join(base, &view.utterance);
		let submit = idle && view.submit;
		if idle {
			// The words are the draft's now, so the next dictation opens on
			// them rather than replacing them.
			self.base = None;
		}
		Some(DictationLanding { draft, submit })
	}

	/// Forgets the dictation this window was writing, for a window that has
	/// moved to another session.
	pub fn reset(&mut self) {
		self.base = None;
	}
}

/// Joins dictated words to the draft they were spoken into, separated unless
/// the draft already ends in a space or is empty.
fn join(base: &str, utterance: &str) -> String {
	if base.is_empty() {
		return utterance.to_owned();
	}
	if base.ends_with(char::is_whitespace) {
		return format!("{base}{utterance}");
	}
	format!("{base} {utterance}")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn frame(state: DictationState, utterance: &str, revision: u64) -> DictationView {
		DictationView {
			state,
			utterance: utterance.to_owned(),
			partial: String::new(),
			submit: false,
			status: None,
			error: None,
			revision,
		}
	}

	#[test]
	fn a_revision_already_written_changes_nothing() {
		let mut draft = DictationDraft::default();
		let first = frame(DictationState::Recording, "hello", 1);
		assert!(draft.land(&first, "note: ").is_some());
		assert_eq!(draft.land(&first, "note: hello"), None);
	}

	#[test]
	fn a_revised_segment_replaces_what_it_revised() {
		let mut draft = DictationDraft::default();
		let first = frame(DictationState::Recording, "hello", 1);
		let second = frame(DictationState::Recording, "hello there", 2);
		assert_eq!(draft.land(&first, "note:").map(|l| l.draft), Some("note: hello".to_owned()));
		assert_eq!(
			draft.land(&second, "note: hello").map(|l| l.draft),
			Some("note: hello there".to_owned())
		);
	}

	#[test]
	fn a_discarded_dictation_puts_back_the_draft_it_opened_on() {
		let mut draft = DictationDraft::default();
		let heard = frame(DictationState::Recording, "hello", 1);
		assert!(draft.land(&heard, "note:").is_some());
		let discarded = frame(DictationState::Idle, "", 2);
		assert_eq!(draft.land(&discarded, "note: hello").map(|l| l.draft), Some("note:".to_owned()));
	}

	#[test]
	fn an_idle_frame_with_no_base_changes_nothing() {
		let mut draft = DictationDraft::default();
		assert_eq!(draft.land(&frame(DictationState::Idle, "", 1), "note:"), None);
	}

	#[test]
	fn the_spoken_submit_phrase_sends_only_once_the_recogniser_has_finished() {
		let mut draft = DictationDraft::default();
		let mut speaking = frame(DictationState::Recording, "ship it", 1);
		speaking.submit = true;
		assert_eq!(draft.land(&speaking, "").map(|l| l.submit), Some(false));
		let mut done = frame(DictationState::Idle, "ship it", 2);
		done.submit = true;
		assert_eq!(draft.land(&done, "ship it").map(|l| l.submit), Some(true));
	}

	#[test]
	fn a_second_dictation_opens_on_the_words_the_first_left() {
		let mut draft = DictationDraft::default();
		assert!(
			draft
				.land(&frame(DictationState::Recording, "one", 1), "")
				.is_some()
		);
		assert!(
			draft
				.land(&frame(DictationState::Idle, "one", 2), "one")
				.is_some()
		);
		assert_eq!(
			draft
				.land(&frame(DictationState::Recording, "two", 3), "one")
				.map(|l| l.draft),
			Some("one two".to_owned())
		);
	}
}
