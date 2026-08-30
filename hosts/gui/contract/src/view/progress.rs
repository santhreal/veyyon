//! How far through a long operation is.

/// Progress, determinate or not.
///
/// `total` being optional is the whole point: a tool that is reading an unknown
/// number of files has progress worth showing and no fraction to show, and a
/// host draws those two states differently. Encoding the unknown case as
/// `total: 0` would divide by zero in every renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
	/// What the operation is, in the imperative: `Indexing`, `Downloading`.
	pub label:   String,
	pub done:    u64,
	/// The count that would complete it, when it is known.
	pub total:   Option<u64>,
	/// The item being worked on now: a path, a package, a host.
	pub current: Option<String>,
}

impl Progress {
	pub fn new(label: impl Into<String>, done: u64) -> Progress {
		Progress { label: label.into(), done, total: None, current: None }
	}

	pub fn total(mut self, total: u64) -> Progress {
		self.total = Some(total);
		self
	}

	pub fn current(mut self, current: impl Into<String>) -> Progress {
		self.current = Some(current.into());
		self
	}

	/// The fraction complete, clamped to `0.0..=1.0`.
	///
	/// [`None`] means indeterminate, and a host draws a moving bar rather than
	/// a filled one. A `done` past `total` clamps rather than overflowing the
	/// bar, because a producer that miscounts should not draw outside its box.
	pub fn fraction(&self) -> Option<f32> {
		let total = self.total?;
		if total == 0 {
			return None;
		}
		Some((self.done as f32 / total as f32).clamp(0.0, 1.0))
	}

	/// Whether the operation reports itself finished.
	pub fn is_complete(&self) -> bool {
		self
			.total
			.is_some_and(|total| total > 0 && self.done >= total)
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! [`Progress::fraction`] is a division a producer controls both sides of.
	//! A zero total divides to infinity, and a `done` past `total` fills past
	//! the end of the bar; both draw as a broken window rather than as a wrong
	//! number, and neither is a panic a test would otherwise see.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a host animates the indeterminate case,
	//! or stalls on a producer that stops reporting.

	use super::*;

	#[test]
	fn a_known_total_gives_a_fraction() {
		assert_eq!(Progress::new("Indexing", 3).total(4).fraction(), Some(0.75));
	}

	#[test]
	fn an_unknown_total_is_indeterminate() {
		assert_eq!(Progress::new("Indexing", 3).fraction(), None);
	}

	#[test]
	fn a_zero_total_is_indeterminate_rather_than_infinite() {
		assert_eq!(Progress::new("Indexing", 3).total(0).fraction(), None);
	}

	#[test]
	fn overshooting_the_total_clamps_to_full() {
		let progress = Progress::new("Indexing", 9).total(4);
		assert_eq!(progress.fraction(), Some(1.0));
		assert!(progress.is_complete());
	}

	#[test]
	fn an_indeterminate_operation_is_never_complete() {
		assert!(!Progress::new("Indexing", 9).is_complete());
		assert!(!Progress::new("Indexing", 0).total(0).is_complete());
	}
}
