//! WHY THIS SUITE EXISTS. Switching to a light appearance changed the store
//! and nothing else. The theme lives in a process-wide global that every
//! element reads through `Theme::get`, and it was written once while the
//! process was starting, so the preference had no path to a drawn frame: the
//! window stayed dark and only the settings row that reports the choice
//! redrew. It looked like a repaint problem and was a preference that reached
//! no reader.
//!
//! THE CLASS. Every preference whose effect is a kit global rather than an
//! element's own state: the frame installs it or nobody does, whatever the
//! store says. Both directions are asserted through a drawn frame, so a
//! preference wired only at startup fails here the way this one did.
//!
//! WHAT IT DOES NOT CATCH. Colour. The test platform has no display, so this
//! asserts which palette the frame installed, not what any pixel came out as;
//! a palette whose light and dark tokens were identical would pass. The
//! capture scenes own that.
//!
//! The base font size, which the same line of the frame installs. It is a
//! process-wide static rather than an app global, so every other windowed test
//! in this binary writes it from its own frames and an assertion on it would
//! pass or fail on thread scheduling. Its metrics are asserted in the kit,
//! against the scale itself.

use gpui::TestAppContext;
use veyyon_gui_core::UiCommand;
use veyyon_gui_kit::theme::{Appearance, Theme};

use crate::the_keyboard_reaches_every_route::open;

#[gpui::test]
fn the_appearance_the_reader_chose_is_the_one_the_frame_installs(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	assert_eq!(
		cx.update(|_, cx| Theme::get(cx).appearance),
		Appearance::Dark,
		"the window did not start on the default appearance"
	);

	for (dark, expected) in [(false, Appearance::Light), (true, Appearance::Dark)] {
		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| {
				shell.perform(UiCommand::SetDarkAppearance(dark), window, cx);
			});
		});
		cx.run_until_parked();

		assert_eq!(
			cx.update(|_, cx| Theme::get(cx).appearance),
			expected,
			"the frame drew the appearance the reader left rather than the one chosen"
		);
	}
}
