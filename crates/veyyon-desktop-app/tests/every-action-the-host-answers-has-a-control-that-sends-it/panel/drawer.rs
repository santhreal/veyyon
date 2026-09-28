//! Gestures on the terminal drawer: its chords, the palette rows that open or
//! act on it, the tabs of its strip and the controls each tab draws, over
//! terminal `term-1` and process `web`, both running.

use crate::harness::Win;

/// Opens the drawer with its chord, on the running terminal.
fn open_drawer(w: &mut Win<'_>) {
	w.keys("secondary-j");
}

/// Opens the drawer on process `web`'s own tab.
fn open_process(w: &mut Win<'_>) {
	open_drawer(w);
	w.click("drawer.tab:process:web");
}

pub(super) fn create_terminal(w: &mut Win<'_>) {
	w.keys("ctrl-shift-`");
}

pub(super) fn attach_terminal(w: &mut Win<'_>) {
	open_drawer(w);
}

pub(super) fn resize_terminal(w: &mut Win<'_>) {
	w.palette("Toggle terminal drawer");
}

pub(super) fn write_terminal(w: &mut Win<'_>) {
	open_drawer(w);
	w.keys("l s enter");
}

pub(super) fn clear_terminal(w: &mut Win<'_>) {
	w.palette("Clear terminal");
}

pub(super) fn restart_terminal(w: &mut Win<'_>) {
	open_drawer(w);
	w.click("drawer.control:restart");
}

pub(super) fn close_terminal(w: &mut Win<'_>) {
	open_drawer(w);
	w.click("drawer.control:close");
}

/// The processes the host sent are listed, so showing the tab asks for none;
/// the refresh button asks again.
pub(super) fn refresh_processes(w: &mut Win<'_>) {
	w.palette("Show processes");
	w.click("drawer-refresh-processes");
}

pub(super) fn process_start(w: &mut Win<'_>) {
	w.palette("Show processes");
	w.click_text("Command to start, as `bun run dev`");
	w.typed("bun run dev");
	w.click("drawer.control:start");
}

pub(super) fn process_stop(w: &mut Win<'_>) {
	w.palette("Show processes");
	w.click("drawer.control:stop:web");
}

pub(super) fn process_signal(w: &mut Win<'_>) {
	w.palette("Show processes");
	w.click("drawer.control:signal:web");
	w.click_text("Terminate");
}

pub(super) fn process_logs(w: &mut Win<'_>) {
	open_process(w);
}

pub(super) fn process_send(w: &mut Win<'_>) {
	open_process(w);
	w.click_text("A line to write to the process");
	w.typed("rs");
	w.click("drawer.control:send:web");
}

pub(super) fn process_restart(w: &mut Win<'_>) {
	open_process(w);
	w.click("drawer.control:restart:web");
}
