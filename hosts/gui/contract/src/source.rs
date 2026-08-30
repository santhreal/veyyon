//! Where a window's data comes from.
//!
//! One trait between the window and everything behind it. A window built
//! against a live transport cannot be drawn without one, which means it cannot
//! be captured, cannot be tested, and every layout question needs a running
//! agent to answer. A window built against this can be driven by fixtures, by a
//! transport, or by a recorded session, and none of those is the special case.

use crate::{screen::Route, session::Frame};

/// Data for a window.
///
/// Every method returns rather than blocking. A [`Source`] that has to wait
/// waits before it is asked: a window frame is drawn on a display's schedule,
/// and a source that blocked in [`Source::frame`] would stall the compositor
/// rather than its own thread.
pub trait Source {
	/// The current drawable instant.
	fn frame(&self) -> Frame;

	/// The screen open over the transcript, if one is.
	///
	/// [`Route::Session`] and [`None`] mean the same thing to a window, and only
	/// one of them is a state: a source reports the route it is on, and
	/// [`Route::Session`] is that route.
	fn route(&self) -> Route {
		Route::Session
	}
}
