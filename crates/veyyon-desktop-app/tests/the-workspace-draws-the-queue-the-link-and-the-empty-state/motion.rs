//! The `display.transitions` setting reaches every driver in the window when
//! the host reports it, after the window opened, together with the system
//! preference.
//!
//! WHY: a window that reads the setting nowhere, or once when it opens, keeps
//! sliding after the operator turned motion off, and one that sets the reduced
//! flag from the setting alone slides a window whose system asks for reduced
//! motion. Every driver reads the app's motion policy, so the class closed is
//! the setting stopping short of that policy: a region toggled after the
//! snapshot lands at once and asks for no frame, each reported value is read
//! as the schema declares it, and one live window walks every pair of setting
//! and system preference.
//!
//! Gap: what a driver does once told to reduce is the regions suite's and the
//! motion crate's subject; here one region is observed and the policy every
//! other driver reads is asserted. Whether the host declares `on` and `off` is
//! the host settings suite's subject.

use std::time::Duration;

use gpui::{Entity, Pixels, TestAppContext, VisualTestContext, px};
use serde_json::{Value, json};
use veyyon_desktop_app::{AppState, actions::workspace as act, driver};
use veyyon_desktop_model::{HostEvent, SettingsView, SnapshotSection};
use veyyon_desktop_ui::theme::size;

use super::open;

/// The settings section the host sends, holding `display.transitions` at
/// `value`.
fn transitions(value: &Value) -> HostEvent {
	let section: SettingsView = serde_json::from_value(json!({
		"display.transitions": {
			"value": value, "default": "on", "source": "profile", "type": "enum",
			"label": "Transitions", "tab": "appearance", "group": "Display",
			"values": ["on", "off"],
		},
	}))
	.expect("the settings section parses");
	HostEvent::Snapshot(SnapshotSection::Settings(section))
}

fn report(app: &Entity<AppState>, cx: &mut VisualTestContext, value: &Value) {
	app.update(cx, |app, cx| app.apply(vec![transitions(value)], cx));
	cx.run_until_parked();
}

/// A workspace whose app moves: the window opens under reduced motion, which
/// is then turned off before anything is toggled.
fn moving(cx: &mut TestAppContext) -> (Entity<AppState>, &mut VisualTestContext) {
	driver::enable();
	let (app, _, cx) = open(cx);
	cx.update(|_, cx| cx.set_reduce_motion(false));
	cx.run_until_parked();
	(app, cx)
}

fn reduced(cx: &mut VisualTestContext) -> bool {
	cx.update(|_, cx| cx.reduce_motion())
}

/// The width of the panel in a frame drawn now, `None` while it is shut.
fn panel(cx: &mut VisualTestContext) -> Option<Pixels> {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), "panel"))
		.map(|bounds| bounds.size.width)
}

fn toggle(cx: &mut VisualTestContext) {
	cx.update(|window, cx| window.dispatch_action(Box::new(act::TogglePanel), cx));
	cx.run_until_parked();
}

/// Moves the clock `by` and delivers the frame the window asked for.
/// Returns whether it asked for one.
fn frame(cx: &mut VisualTestContext, by: Duration) -> bool {
	cx.executor().advance_clock(by);
	let asked = cx.update(|window, cx| window.simulate_next_frame(cx)) > 0;
	cx.run_until_parked();
	asked
}

fn rest(cx: &mut VisualTestContext) {
	for _ in 0..240 {
		if !frame(cx, Duration::from_millis(16)) {
			return;
		}
	}
	panic!("the window still asks for frames four seconds after a toggle");
}

#[test]
fn a_transitions_setting_reported_after_the_window_opened_lands_a_toggled_region_at_once() {
	let mut cx = TestAppContext::single();
	let (app, cx) = moving(&mut cx);

	toggle(cx);
	assert!(
		frame(cx, Duration::from_millis(48)),
		"with motion on, an opening panel asks for frames"
	);
	let opening = panel(cx).expect("an opening panel is drawn");
	assert!(opening > px(0.) && opening < size::PANEL, "the panel slides: {opening:?}");
	rest(cx);

	report(&app, cx, &json!("off"));
	toggle(cx);
	assert_eq!(panel(cx), None, "the panel shut on the frame after the toggle");
	assert!(!frame(cx, Duration::from_millis(16)), "no frame is asked for after it lands");
	toggle(cx);
	assert_eq!(panel(cx), Some(size::PANEL), "the panel opened to its size at once");
	assert!(!frame(cx, Duration::from_millis(16)), "no frame is asked for after it lands");

	report(&app, cx, &json!("on"));
	toggle(cx);
	assert!(frame(cx, Duration::from_millis(48)), "motion turned back on slides the panel again");
	let closing = panel(cx).expect("a closing panel is drawn");
	assert!(closing > px(0.) && closing < size::PANEL, "the panel slides: {closing:?}");
}

/// The values the host may report, including one the schema does not declare
/// and ones of other JSON types.
fn values() -> [Value; 6] {
	[json!("on"), json!("off"), json!("shimmer"), json!(false), json!(0), Value::Null]
}

#[test]
fn only_off_turns_motion_off_whatever_else_the_host_reports() {
	let mut cx = TestAppContext::single();
	let (app, cx) = moving(&mut cx);
	let mut reducing = Vec::new();
	for value in values() {
		// Each value follows `off`, so a value read as off keeps the window
		// still and one read as on starts it.
		report(&app, cx, &json!("off"));
		assert!(reduced(cx), "`off` stops the window");
		report(&app, cx, &value);
		if reduced(cx) {
			reducing.push(value);
		}
	}
	assert_eq!(reducing, [json!("off")], "the values that turn motion off");
}

/// The (setting reduces, system reduces) pairs one window walks through, in
/// order. Each input turns on and off under both values of the other, so a
/// flag that follows only the latest change of either is caught as well as
/// one that follows the setting alone.
const SETTING_AND_SYSTEM: [(bool, bool); 8] = [
	(false, false),
	(false, true),
	(true, true),
	(true, false),
	(false, false),
	(true, false),
	(true, true),
	(false, true),
];

#[test]
fn the_system_preference_reduces_motion_whatever_the_setting_leaves_on() {
	let mut cx = TestAppContext::single();
	let (app, cx) = moving(&mut cx);
	for (setting, system) in SETTING_AND_SYSTEM {
		report(&app, cx, &json!(if setting { "off" } else { "on" }));
		cx.simulate_reduce_motion_change(system);
		cx.run_until_parked();
		assert_eq!(
			reduced(cx),
			setting || system,
			"the setting reduces: {setting}, the system reduces: {system}; either one stops the \
			 window and neither alone starts it"
		);
	}
}
