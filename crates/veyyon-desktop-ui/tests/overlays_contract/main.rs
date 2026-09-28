//! Contracts of the overlay primitives, driven through GPUI's test app.
//!
//! WHY: a menu that lands the keyboard highlight on a separator, header or
//! disabled row lets Enter pick nothing or the wrong action; a tab strip that
//! stops at its ends leaves keyboard users stranded; a tab wrapper whose
//! element is dropped leaves the owner with no tab bounds; a popover that
//! animates under reduced motion moves for an operator who turned motion off;
//! a toast stack that grows or never dismisses covers the window; a toast
//! that outlives the lifetime its owner gave it, or goes without the stack
//! reporting it, leaves the owner's queue holding a notice nobody sees; a
//! toast exit that moves under reduced motion, or never ends, keeps the
//! window drawing frames; a long message that widens its toast pushes the
//! toast's buttons past the window edge.
//!
//! It does not catch pixel geometry (the anchored position, the underline's
//! slide path, the scrollbar thumb), which a headless render covers.

mod keys;
mod toasts;

use veyyon_desktop_ui::theme::{Appearance, Theme};
use veyyon_gpui::TestAppContext;

pub(crate) fn app() -> TestAppContext {
	let cx = TestAppContext::single();
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the embedded dark palette parses");
	cx
}
