//! Reduced motion: the `display.transitions` setting the host reports, or the
//! operating system's preference.
//!
//! Every driver in the window reads the app's motion policy, so the setting
//! reaches them through the policy's reduced flag. The flag is resolved again
//! whenever either input changes, so a setting that arrives after the window
//! opened stops it, and the flag is the setting or the system preference, so
//! neither alone starts a window the other stops. A flag set on the app
//! directly holds until an input changes.

use gpui::{App, Entity};
use veyyon_desktop_model::Store;

use crate::AppState;

/// The setting that states whether structural motion is on.
const TRANSITIONS_SETTING: &str = "display.transitions";

/// The inputs the reduced flag was last resolved from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Reduced {
	setting: bool,
	system:  bool,
}

impl Reduced {
	/// The inputs before the host reports a setting.
	pub(super) fn new(cx: &App) -> Self {
		Self { setting: false, system: cx.system_reduce_motion() }
	}

	/// Sets the app's reduced flag to the setting of `app` or the system
	/// preference, when either changed since the last resolution.
	pub(super) fn resolve(&mut self, app: &Entity<AppState>, cx: &mut App) {
		let setting = turned_off(app.read(cx).store());
		let next = Self { setting, system: cx.system_reduce_motion() };
		if next != *self {
			*self = next;
			cx.set_reduce_motion(next.setting || next.system);
		}
	}
}

/// Whether `store` holds the transitions setting at `off`. The schema
/// declares `on` and `off`, so any other value, or none, leaves motion on.
fn turned_off(store: &Store) -> bool {
	store
		.domains
		.settings
		.as_ref()
		.and_then(|settings| settings.get(TRANSITIONS_SETTING))
		.and_then(|entry| entry.value.as_str())
		== Some("off")
}
