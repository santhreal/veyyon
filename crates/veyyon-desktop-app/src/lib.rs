//! Application state and views for the veyyon desktop front end.
//!
//! [`AppState`] is the one entity every view reads. It reduces host events
//! into the model's [`Store`](veyyon_desktop_model::Store) and emits one typed
//! [`StoreEvent`] per region a batch changed, so a view re-renders only when
//! an event concerns it. [`workspace::Workspace`] is the window's root view:
//! it lays the regions out and owns the layout they read.

// The GPUI derive macros expand to `gpui::` paths.
extern crate veyyon_gpui as gpui;

pub mod state;

// Shell
pub mod actions;
pub mod driver;
pub mod keymap;
pub mod regions;
pub mod workspace;

// Thread
pub mod thread;
pub mod transcript;

// Sidebar
pub mod sidebar;

// Palette
pub mod palette;
pub mod settings;

// Panel
pub mod drawer;
pub mod panel;

// Composer
pub mod composer;
pub mod dock;

pub use state::{AppState, Project, SessionRow, StoreEvent, TRANSCRIPT_CACHE_SESSIONS};

/// Registers what every region needs before the first window opens: the
/// workspace's layout global and the App-level action listeners each region
/// installs.
pub fn init(cx: &mut gpui::App) {
	// Shell
	workspace::init(cx);
	// Sidebar
	sidebar::init(cx);
	// Thread
	thread::init(cx);
	// Panel
	panel::init(cx);
	drawer::init(cx);
	// Composer
	composer::init(cx);
	dock::init(cx);
}
