//! What closing the window does to the process.
//!
//! The window's own verbs are answered here rather than sent to a host: no
//! host owns the window, and a close that asked one first would end the
//! process on a transport that had stopped answering.

use veyyon_desktop::launch::{WindowExit, WindowSlot, reopen_available, window_exit};
use veyyon_desktop_surface::{Intent, ShellView};
use veyyon_gpui::{App, Context, Window, WindowHandle};

use super::Host;

/// Closes the window, after everything it holds is written.
///
/// `Quit` ends the process outright. `CloseWindow` ends it only when nothing
/// can bring a window back, which is what `window_exit` decides from the
/// windows still open and the platform's own answer.
pub(super) fn close(
	host: &mut Host,
	intent: &Intent,
	window: &WindowHandle<ShellView>,
	slot: &WindowSlot,
	now_ms: u64,
	cx: &mut App,
) {
	let quitting = matches!(intent, Intent::Quit)
		|| window_exit(cx.windows().len(), reopen_available()) == WindowExit::CloseAndQuit;
	let _ = window.update(cx, |view, gpui_window, cx| {
		write_everything(host, view, gpui_window, now_ms, cx);
		gpui_window.remove_window();
	});
	*slot.borrow_mut() = None;
	if quitting {
		cx.quit();
	}
}

/// Records the drawn window's shape and writes every store waiting, which is
/// what a window that is going owes the next one (§8.10).
///
/// A store that could not be written is stated on stderr: the window is on
/// its way out, so there is no surface left to put it on.
pub(super) fn write_everything(
	host: &mut Host,
	view: &mut ShellView,
	window: &Window,
	now_ms: u64,
	cx: &mut Context<ShellView>,
) {
	host.keep(view, window, now_ms, cx);
	if let Some(keeper) = host.keeper.as_mut() {
		for failure in keeper.flush_all() {
			eprintln!(
				"warn: {store} was not saved: {reason}",
				store = failure.kind.file_name(),
				reason = failure.reason,
			);
		}
	}
}
