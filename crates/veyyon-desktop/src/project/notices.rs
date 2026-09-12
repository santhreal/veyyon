//! From the queue of raised announcements to the stack the window draws.
//!
//! The queue is the model's: it dedupes by key, orders by priority, bounds
//! what is held and states when each announcement is due to go. The window
//! draws what the queue holds and decides nothing about it, so an
//! announcement that is up in one and not the other is a defect in this file
//! and nowhere else.
//!
//! An announcement goes on its own clock, not on the traffic that raised it.
//! The window's one-second tick is what takes an expired one off, so a toast
//! raised by the last event of a burst still leaves without another event.

use veyyon_desktop_model::Store;
use veyyon_desktop_surface::ShellState;

/// Draws the stack from the queue, leaving out anything already due to go.
///
/// The filter is what keeps a projection between two ticks honest: a frame
/// drawn a second after an announcement expired states the stack the next
/// tick will hold, not the one the last tick left.
pub fn project_notices(store: &Store, now_ms: u64, state: &mut ShellState) {
	state.notices = store
		.notifications
		.raised()
		.iter()
		.filter(|notice| !notice.has_expired(now_ms))
		.cloned()
		.collect();
}

/// Takes every announcement whose time is up off the queue and redraws the
/// stack, reporting whether what the window draws changed.
///
/// Called from the window's own clock, which is the only thing that moves
/// when a session is idle and a toast is still up.
pub fn expire_notices(store: &mut Store, now_ms: u64, state: &mut ShellState) -> bool {
	store.notifications.expire(now_ms);
	let held: Vec<&str> = state.notices.iter().map(|held| held.key.as_str()).collect();
	let after: Vec<&str> = store
		.notifications
		.raised()
		.iter()
		.filter(|notice| !notice.has_expired(now_ms))
		.map(|notice| notice.key.as_str())
		.collect();
	let changed = held != after;
	if changed {
		project_notices(store, now_ms, state);
	}
	changed
}
