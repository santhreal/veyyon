//! WHY: §8.10 states that a window closes, what it holds is written, and the
//! process ends only when nothing is left that could bring a window back. A
//! process that ended with any window, or never ended with the last one on a
//! platform with no dock, breaks that.
//!
//! CLASS CLOSED: the decision itself. The exit table is swept over every
//! count of open windows around the boundary and both answers a platform can
//! give, so the one cell that ends the process is pinned rather than asserted
//! once; `reopen_available` is pinned against the platform it is compiled for.
//!
//! WHAT IT DOES NOT CATCH: the platform side of the close. That
//! `remove_window` takes the window down and that a dock icon raises
//! `on_reopen` are the window server's and are exercised by the binary rather
//! than here; a headless test platform has no dock.

use veyyon_desktop::launch::{WindowExit, reopen_available, window_exit};

#[test]
fn the_process_ends_only_when_the_last_window_goes_and_nothing_can_reopen() {
	// The whole table around the boundary, so the one cell that ends the
	// process is the one asserted rather than the one remembered.
	for windows_open in 0_usize..=3 {
		for reopen in [false, true] {
			let expected = if windows_open > 1 || reopen {
				WindowExit::CloseWindow
			} else {
				WindowExit::CloseAndQuit
			};
			assert_eq!(
				window_exit(windows_open, reopen),
				expected,
				"{windows_open} window(s) open with reopen available = {reopen}"
			);
		}
	}
	assert_eq!(
		window_exit(1, false),
		WindowExit::CloseAndQuit,
		"the last window of a platform with no way back takes the process with it"
	);
	assert_eq!(
		window_exit(2, false),
		WindowExit::CloseWindow,
		"closing one of two windows never ends the process, whatever the platform"
	);
	assert_eq!(
		window_exit(1, true),
		WindowExit::CloseWindow,
		"a platform that can reopen keeps the process up with no window"
	);
}

#[test]
fn only_a_platform_that_keeps_an_application_up_without_a_window_can_reopen() {
	assert_eq!(
		reopen_available(),
		cfg!(target_os = "macos"),
		"macOS keeps the menu bar and the dock icon up with no window; nothing else does"
	);
}
