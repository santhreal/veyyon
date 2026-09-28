//! The sidebar row model: the title filter, the status glyph of a row, and
//! the relative time label of a row with the instant it next changes.

use veyyon_desktop_model::{SessionBadge, Store, session_badge};

use crate::state::SessionRow;

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;
const DAY_MS: u64 = 24 * HOUR_MS;

/// Whether `text` contains `folded`, a lowercase needle, ignoring case.
pub fn contains_folded(text: &str, folded: &str) -> bool {
	if folded.is_empty() {
		return true;
	}
	if text.is_ascii() && folded.is_ascii() {
		return text
			.as_bytes()
			.windows(folded.len())
			.any(|window| window.eq_ignore_ascii_case(folded.as_bytes()));
	}
	text.to_lowercase().contains(folded)
}

/// The state a row's leading glyph shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
	/// A turn is running, or the open session's processes run in the
	/// background, as the label states.
	Running(&'static str),
	/// The session waits on the operator for what the label states: an
	/// approval, an answer or a plan review.
	Waiting(&'static str),
	/// The last turn failed and the failure has not been read.
	Error,
	/// The session finished, or a deferral came due, as the label states,
	/// since it was last read.
	Unread(&'static str),
	/// Nothing needs attention.
	Idle,
}

impl Glyph {
	/// The glyph of `row`, from the badge the model derives for it.
	pub fn of(store: &Store, row: &SessionRow, now_ms: u64) -> Self {
		match session_badge(store, &row.id, now_ms) {
			Some(SessionBadge::Approval) => Self::Waiting("Waiting on an approval"),
			Some(SessionBadge::Input) => Self::Waiting("Waiting on an answer"),
			Some(SessionBadge::Plan) => Self::Waiting("A plan to review"),
			Some(SessionBadge::Failed) => Self::Error,
			Some(SessionBadge::Working { .. }) => Self::Running("Working"),
			Some(SessionBadge::Done) => Self::Unread("Finished"),
			Some(SessionBadge::Due) => Self::Unread("Deferral due"),
			Some(SessionBadge::Watching) => Self::Running("Processes running in the background"),
			None => Self::Idle,
		}
	}

	/// What the glyph states, the text of its tooltip; `None` for no glyph.
	pub const fn label(self) -> Option<&'static str> {
		match self {
			Self::Running(label) | Self::Waiting(label) | Self::Unread(label) => Some(label),
			Self::Error => Some("Failed"),
			Self::Idle => None,
		}
	}
}

/// The age of `then_ms` at `now_ms` in the largest whole unit: `now` under a
/// minute, then `2m`, `1h`, `3d`.
pub fn relative_label(now_ms: u64, then_ms: u64) -> String {
	let age = now_ms.saturating_sub(then_ms);
	if age < MINUTE_MS {
		"now".to_owned()
	} else if age < HOUR_MS {
		format!("{}m", age / MINUTE_MS)
	} else if age < DAY_MS {
		format!("{}h", age / HOUR_MS)
	} else {
		format!("{}d", age / DAY_MS)
	}
}

/// The instant after `now_ms` at which [`relative_label`] of `then_ms`
/// changes.
pub const fn next_label_change_ms(now_ms: u64, then_ms: u64) -> u64 {
	let age = now_ms.saturating_sub(then_ms);
	let unit = if age < HOUR_MS {
		MINUTE_MS
	} else if age < DAY_MS {
		HOUR_MS
	} else {
		DAY_MS
	};
	let base = if then_ms > now_ms { now_ms } else { then_ms };
	base.saturating_add((age / unit + 1).saturating_mul(unit))
}

#[cfg(test)]
mod tests {
	use super::{DAY_MS, HOUR_MS, MINUTE_MS, contains_folded, next_label_change_ms, relative_label};

	#[test]
	fn labels_step_through_now_minutes_hours_and_days() {
		let cases = [
			(0, "now"),
			(MINUTE_MS - 1, "now"),
			(MINUTE_MS, "1m"),
			(HOUR_MS - 1, "59m"),
			(HOUR_MS, "1h"),
			(DAY_MS - 1, "23h"),
			(DAY_MS, "1d"),
			(3 * DAY_MS + 5, "3d"),
		];
		for (age, label) in cases {
			assert_eq!(relative_label(10 * DAY_MS, 10 * DAY_MS - age), label, "age {age}");
		}
		assert_eq!(relative_label(0, 5), "now", "a timestamp ahead of the clock");
	}

	#[test]
	fn the_next_change_is_the_first_instant_the_label_differs() {
		let then = 1_000;
		for age in [0, 59_999, MINUTE_MS, HOUR_MS - 1, HOUR_MS, DAY_MS - 1, DAY_MS, 3 * DAY_MS] {
			let now = then + age;
			let next = next_label_change_ms(now, then);
			assert!(next > now, "age {age}");
			assert_eq!(relative_label(next - 1, then), relative_label(now, then), "age {age}");
			assert_ne!(relative_label(next, then), relative_label(now, then), "age {age}");
		}
	}

	#[test]
	fn the_filter_ignores_case_in_ascii_and_unicode() {
		assert!(contains_folded("Fix Parser Arena", "parser"));
		assert!(contains_folded("Größe ändern", "größe"));
		assert!(!contains_folded("Fix parser", "lexer"));
		assert!(contains_folded("anything", ""));
		assert!(!contains_folded("ab", "abc"));
	}
}
