//! Large queue fixture for scroll, paging, and keyboard selection tests.

use veyyon_desktop_surface::{Badge, Section, ShellState, fixture};

use super::queue_scroll::row;

pub fn make_large_queue_state() -> ShellState {
	let mut state = fixture::populated();
	state.sections = vec![
		(
			Section::Unsent,
			(1..=5)
				.map(|i| row(i, format!("Unsent {i}"), "draft", None, None))
				.collect(),
		),
		(
			Section::Pinned,
			(6..=15)
				.map(|i| row(i, format!("Pinned {i}"), "core", Some(Badge::Approval), Some("2m")))
				.collect(),
		),
		(
			Section::Live,
			(16..=45)
				.map(|i| {
					let b = if i % 2 == 0 {
						Some(Badge::Working)
					} else {
						Some(Badge::Watching)
					};
					row(i, format!("Live {i}"), "gui", b, Some("10m"))
				})
				.collect(),
		),
		(
			Section::Deferred,
			(46..=70)
				.map(|i| row(i, format!("Deferred {i}"), "def", Some(Badge::Due), Some("1h")))
				.collect(),
		),
		(
			Section::Parked,
			(71..=120)
				.map(|i| row(i, format!("Parked {i}"), "arc", Some(Badge::Done), Some("3d")))
				.collect(),
		),
	];
	state
}
