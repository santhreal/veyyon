//! Application state and views for the veyyon desktop front end.
//!
//! [`AppState`] is the one entity every view reads. It reduces host events
//! into the model's [`Store`](veyyon_desktop_model::Store) and emits one typed
//! [`StoreEvent`] per region a batch changed, so a view re-renders only when
//! an event concerns it.

pub mod state;

pub use state::{AppState, Project, SessionRow, StoreEvent, TRANSCRIPT_CACHE_SESSIONS};
