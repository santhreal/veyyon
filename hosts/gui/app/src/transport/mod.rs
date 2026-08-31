//! How the window reaches an engine.
//!
//! The window holds no engine of its own. Every value a surface draws arrived
//! as a [`HostEvent`](veyyon_gui_core::host::HostEvent) and every action leaves
//! as a [`HostRequest`](veyyon_gui_core::host::HostRequest), so a transport has
//! one job: move those two types over a socket without inventing either.
//!
//! The pieces, smallest first: [`Endpoint`] is the address as written,
//! [`frames`] is one JSON value per line, `outbox` holds intent that has no
//! socket yet, `socket` flattens unix and TCP into one stream, and [`Session`]
//! is the thread that connects, reads, reports why it stopped, and connects
//! again.
//!
//! What a reader sees when there is no engine is a state, never a blank: the
//! window opens `Detached` with no endpoint set, shows `Connecting` and
//! `Reconnecting` with the time of the next attempt while a socket is being
//! made, and shows `Fatal` for the faults that repeating cannot fix — an
//! unparseable endpoint, a protocol the engine does not share, a frame that is
//! not the JSON this side speaks. No path here fabricates a snapshot.

mod endpoint;
mod frames;
mod outbox;
mod session;
mod socket;

#[cfg(test)]
mod a_dropped_connection_comes_back_and_says_when;
#[cfg(test)]
mod a_frame_is_one_line_and_a_line_is_bounded;
#[cfg(test)]
mod an_engine_that_is_not_there_never_looks_connected;
#[cfg(test)]
mod engine_double;

use endpoint::{ENDPOINT_ENV, Endpoint};
use session::Session;

use crate::bridge::Bridge;

/// The bridge the environment asks for.
///
/// No endpoint means the window opens detached, which is a state and not a
/// failure. An endpoint that is not an address is a failure, and it reaches the
/// reader the same way every other connection failure does, as a `Fatal` state
/// carrying what was wrong with it.
pub fn attach() -> Bridge {
	match Endpoint::from_environment() {
		None => Bridge::detached(),
		Some(Ok(endpoint)) => Bridge::attached(Box::new(Session::connect(endpoint))),
		Some(Err(error)) => Bridge::attached(Box::new(Session::fatal(format!(
			"{ENDPOINT_ENV} is not an address: {error}"
		)))),
	}
}
