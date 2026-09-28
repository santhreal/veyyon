//! What closing a window means for the process.
//!
//! Closing is two decisions, not one. The window goes, and the process either
//! stays up so something can bring a window back or ends with it. Only the
//! platform knows whether anything can reopen, so that answer is supplied at
//! the call site and the decision itself is a function of it.

/// What closing a window does to the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowExit {
	/// The window goes and the process stays up, because something can bring
	/// a window back.
	CloseWindow,
	/// The window goes and the process ends with it, because nothing can.
	CloseAndQuit,
}

/// Whether closing the last window leaves a process anything can reopen.
///
/// macOS keeps an application up with no window: the menu bar stays, the dock
/// icon stays, and a press on either asks for a window back. Everywhere else a
/// process with no window is a process with no way in, so it ends.
#[must_use]
pub const fn reopen_available() -> bool {
	cfg!(target_os = "macos")
}

/// What closing one window does, given how many are open and whether anything
/// can reopen.
///
/// Closing one of several windows never ends the process, whatever the
/// platform; closing the last one ends it unless a reopen can bring it back.
#[must_use]
pub const fn window_exit(windows_open: usize, reopen_available: bool) -> WindowExit {
	if windows_open > 1 || reopen_available {
		WindowExit::CloseWindow
	} else {
		WindowExit::CloseAndQuit
	}
}
