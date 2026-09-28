//! The palette rows that send a request themselves: the host connection's,
//! the open thread's fork and reload, and the share's join and refresh.

use veyyon_desktop_model::SnapshotSectionKind;

use crate::harness::{Win, corpus};

pub(super) fn attach(w: &mut Win<'_>) {
	w.palette("Attach to host");
}

pub(super) fn detach(w: &mut Win<'_>) {
	w.palette("Detach from host");
}

pub(super) fn reconnect(w: &mut Win<'_>) {
	w.palette("Reconnect to host");
}

pub(super) fn shut_down(w: &mut Win<'_>) {
	w.palette("Shut down host");
}

pub(super) fn fork(w: &mut Win<'_>) {
	w.palette("Fork this thread");
}

pub(super) fn reload(w: &mut Win<'_>) {
	w.palette("Reload the transcript");
}

/// Picks the join row, which asks for the link, and enters one.
pub(super) fn join(w: &mut Win<'_>) {
	w.palette("Join a share");
	w.typed("https://relay.example.com/room/room-2");
	w.keys("enter");
}

/// Refreshes the share the host states this window hosts.
pub(super) fn refresh_share(w: &mut Win<'_>) {
	w.apply(vec![corpus(SnapshotSectionKind::Share)]);
	w.palette("Refresh the share");
}
