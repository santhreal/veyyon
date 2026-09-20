//! The freeze every agent in the host process runs under (§4.1).

use serde::{Deserialize, Serialize};

/// Whether the host's agents are frozen, and since when.
///
/// The host holds one gate for the whole process: the main session, every
/// spawned agent and the advisor poll it at their action boundaries, so a
/// pause is not a property of the session the window has open. Every attached
/// window therefore reads the same value, and a pause engaged from a terminal
/// running beside the window reaches the window the same way one it engaged
/// itself does.
///
/// `since_ms` is the wall clock the host started the pause on, not a duration,
/// so a window that attaches mid-pause states how long the freeze has run
/// rather than starting a clock of its own at zero. It is `None` exactly when
/// `paused` is false.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPauseView {
	/// True while every agent in the host process is frozen.
	pub paused:   bool,
	/// Epoch milliseconds the current freeze began; `None` while running.
	pub since_ms: Option<u64>,
}

impl AgentPauseView {
	/// The state of a host whose agents are running.
	pub const RUNNING: Self = Self { paused: false, since_ms: None };

	/// How long the freeze has run at `now_ms`, or `None` while running.
	///
	/// Saturating rather than signed: a host clock behind the window's own
	/// reads as a freeze that just began, which is what a bar with one line
	/// for the duration can say. A negative duration has no spelling there.
	#[must_use]
	pub fn elapsed_ms(self, now_ms: u64) -> Option<u64> {
		self
			.since_ms
			.filter(|_| self.paused)
			.map(|since| now_ms.saturating_sub(since))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_running_host_has_no_clock_to_state() {
		assert_eq!(AgentPauseView::RUNNING.elapsed_ms(10_000), None);
	}

	#[test]
	fn a_freeze_states_how_long_it_has_run() {
		let paused = AgentPauseView { paused: true, since_ms: Some(4_000) };
		assert_eq!(paused.elapsed_ms(10_000), Some(6_000));
	}

	#[test]
	fn a_host_clock_ahead_of_the_window_reads_as_a_freeze_just_begun() {
		let paused = AgentPauseView { paused: true, since_ms: Some(10_000) };
		assert_eq!(paused.elapsed_ms(4_000), Some(0));
	}

	#[test]
	fn a_stale_mark_left_on_a_released_freeze_states_nothing() {
		let released = AgentPauseView { paused: false, since_ms: Some(4_000) };
		assert_eq!(released.elapsed_ms(10_000), None);
	}
}
