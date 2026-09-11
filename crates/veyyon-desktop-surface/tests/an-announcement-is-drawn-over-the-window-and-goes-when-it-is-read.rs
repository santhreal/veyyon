//! WHY: nothing in this window drew an announcement. A request refused behind
//! a closed sheet and a decision waiting on a session that is not open both
//! reached the store's queue and stopped there, so the operator's only way to
//! learn of either was to go looking for it.
//!
//! CLASS CLOSED: the stack is drawn from the queue and from nothing else, it
//! covers neither the composer it floats over nor the window's chrome, a press
//! on a card takes that card and only that card down, the dismissal reaches
//! the host so the next projection does not put it back, and a card at rest
//! under reduced motion is drawn at rest in the first frame rather than
//! sliding. Each case drives the real `render_shell` path and reads the boxes
//! and runs the frame reported.
//!
//! NOT CAUGHT: what raises an announcement, which is the model's reducer
//! suite, and the queue's own dedupe, order, expiry and bound, which is the
//! model's queue suite. A stack drawn correctly from a queue that holds the
//! wrong thing passes here.

#[path = "support/detail/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared window helpers")]
mod window;

use veyyon_desktop_model::{Notification, NotificationPriority, NotificationSource};
use veyyon_desktop_scene::headless::Captured;
use veyyon_desktop_surface::{Intent, ShellState, fixture};
use veyyon_gpui::{Bounds, Pixels, Point, px};
use window::{
	HEIGHT, WIDTH, changed_pixels, inside_window, open_window, runs_labelled, settled_frame,
};

const NOW_MS: u64 = 1_700_000_000_000;

/// The state every case opens on: the window as the fixture leaves it, with
/// motion off unless the case is about motion.
fn state_with(notices: Vec<Notification>) -> ShellState {
	let mut state = fixture::populated();
	state.reduced_motion = true;
	state.notices = notices;
	state
}

fn announcement(key: &str, title: &str, priority: NotificationPriority) -> Notification {
	Notification {
		key: key.to_owned(),
		source: NotificationSource::RequestFailed,
		priority,
		title: title.to_owned(),
		detail: Some("Settings".to_owned()),
		raised_at_ms: NOW_MS,
	}
}

/// The box of the one run of `label` the frame drew.
fn run_box(captured: &Captured, label: &str) -> Bounds<Pixels> {
	let mut found = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label);
	let run = found
		.next()
		.unwrap_or_else(|| panic!("the frame drew no run of {label}"));
	assert!(found.next().is_none(), "{label} is drawn more than once");
	run.bounds
}

fn centre(bounds: Bounds<Pixels>) -> Point<Pixels> {
	Point {
		x: bounds.origin.x + bounds.size.width / 2.0,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

#[test]
fn an_empty_queue_draws_no_stack() {
	open_window(state_with(Vec::new()), |session| {
		let captured = settled_frame(session);
		assert_eq!(
			runs_labelled(&captured, "cannot write"),
			0,
			"a window with nothing announced draws nothing"
		);
	});
}

#[test]
fn a_raised_announcement_is_drawn_at_the_trailing_edge_under_the_chrome() {
	let notices =
		vec![announcement("request-failed:Settings:-", "cannot write", NotificationPriority::Normal)];
	open_window(state_with(notices), |session| {
		let captured = settled_frame(session);
		let title = run_box(&captured, "cannot write");
		assert!(inside_window(title), "the card is drawn inside the window: {title:?}");

		let detail = run_box(&captured, "Settings");
		assert!(
			f32::from(detail.origin.y) > f32::from(title.origin.y),
			"the detail is drawn under the line it qualifies"
		);

		let left = f32::from(title.origin.x);
		assert!(
			left > f32::from(px(f32::from(WIDTH) / 2.0)),
			"the stack is at the trailing edge, clear of the rail: {left}"
		);
		let top = f32::from(title.origin.y);
		assert!(top > 0.0, "and under the chrome rather than over the titlebar: {top}");
		assert!(
			top < f32::from(HEIGHT) / 2.0,
			"the stack grows down from the top, so the first card is in the upper half: {top}"
		);
	});
}

#[test]
fn the_cards_are_stacked_in_the_order_the_queue_holds_them() {
	let notices = vec![
		announcement("first", "first refusal", NotificationPriority::Urgent),
		announcement("second", "second refusal", NotificationPriority::Normal),
		announcement("third", "third refusal", NotificationPriority::Low),
	];
	open_window(state_with(notices), |session| {
		let captured = settled_frame(session);
		let first = run_box(&captured, "first refusal");
		let second = run_box(&captured, "second refusal");
		let third = run_box(&captured, "third refusal");

		assert!(
			f32::from(first.origin.y) < f32::from(second.origin.y),
			"the queue's order is the stack's order, top down"
		);
		assert!(f32::from(second.origin.y) < f32::from(third.origin.y));
		assert_eq!(
			f32::from(first.origin.x),
			f32::from(third.origin.x),
			"every card is the same width at the same edge"
		);
		for card in [first, second, third] {
			assert!(inside_window(card), "a card was drawn off the window: {card:?}");
		}
	});
}

#[test]
fn a_full_stack_stays_clear_of_the_composer_it_floats_over() {
	let notices: Vec<Notification> = (0..veyyon_desktop_model::NOTIFICATION_CAPACITY)
		.map(|slot| {
			announcement(
				&format!("slot-{slot}"),
				&format!("refusal number {slot}"),
				NotificationPriority::Normal,
			)
		})
		.collect();
	open_window(state_with(notices), |session| {
		let captured = settled_frame(session);
		let last = run_box(&captured, "refusal number 5");
		let bottom = f32::from(last.origin.y) + f32::from(last.size.height);
		assert!(
			bottom < f32::from(HEIGHT) * 0.75,
			"a full stack ends well above the composer band: {bottom}"
		);
		assert!(inside_window(last));
	});
}

#[test]
fn a_press_on_a_card_takes_that_card_down_and_tells_the_host() {
	let notices = vec![
		announcement("keep-me", "another refusal", NotificationPriority::Normal),
		announcement("press-me", "cannot write", NotificationPriority::Normal),
	];
	open_window(state_with(notices), |session| {
		let captured = settled_frame(session);
		let target = centre(run_box(&captured, "cannot write"));
		session
			.update(|view, _window, _cx| {
				let _ = view.drain_intents();
			})
			.expect("the recorded intents are taken");

		session.click(target).expect("the card takes the press");
		let (intents, held) = session
			.update(|view, _window, _cx| {
				(
					view.drain_intents(),
					view
						.state()
						.notices
						.iter()
						.map(|notice| notice.key.clone())
						.collect::<Vec<_>>(),
				)
			})
			.expect("the view's state is read");

		assert_eq!(
			intents,
			vec![Intent::DismissNotice("press-me".to_owned())],
			"the press reports the card it was on, so the queue behind it is cleared too"
		);
		assert_eq!(held, ["keep-me"], "and the card beside it is left up");

		let after = settled_frame(session);
		assert_eq!(runs_labelled(&after, "cannot write"), 0, "the card is gone from the frame");
		assert_eq!(runs_labelled(&after, "another refusal"), 1, "the other one is still drawn");
	});
}

/// How much of a card's own text may be redrawn and still count as a card
/// that was left alone.
///
/// The renderer does not produce two byte-identical frames of the same text --
/// a settled card against itself measures around a tenth of its glyph area --
/// and a card whose entrance restarted is redrawn from nothing, which measures
/// above nine tenths. The two are an order of magnitude apart, so the bar sits
/// between them rather than at either end.
const LEFT_ALONE: f32 = 0.5;
/// How much of a card arriving must be redrawn for its entrance to be running.
const ARRIVING: f32 = 0.75;

/// The fraction of `area` two frames disagree on.
fn changed_fraction(before: &Captured, after: &Captured, area: Bounds<Pixels>) -> f32 {
	let pixels = f32::from(area.size.width) * f32::from(area.size.height);
	assert!(pixels > 0.0, "the box {area:?} holds no pixels");
	changed_pixels(&before.frame, &after.frame, area) as f32 / pixels
}

#[test]
fn a_card_arriving_leaves_the_transition_of_the_one_above_it_alone() {
	// Each slot in the stack animates on its own track, named for the surface
	// that owns the stack and slotted by the position the card holds. Two
	// cards sharing a track is the defect this reads: the card already at rest
	// would restart its entrance every time another arrived, which is a
	// flicker at the top of the stack whenever anything fails twice.
	let first = announcement("first", "first refusal", NotificationPriority::Normal);
	let second = announcement("second", "second refusal", NotificationPriority::Normal);
	let mut state = state_with(vec![first]);
	state.reduced_motion = false;
	open_window(state, |session| {
		let at_rest = settled_frame(session);
		let resting_box = run_box(&at_rest, "first refusal");

		session
			.update(move |view, _window, cx| {
				view.state_mut().notices.push(second);
				cx.notify();
			})
			.expect("the second announcement is raised");
		let arriving = session
			.frame()
			.expect("the frame the second card arrives in");

		assert_eq!(
			f32::from(run_box(&arriving, "first refusal").origin.y),
			f32::from(resting_box.origin.y),
			"the card at rest does not move when another arrives under it"
		);
		let disturbed = changed_fraction(&at_rest, &arriving, resting_box);
		assert!(
			disturbed < LEFT_ALONE,
			"the card at rest kept its own track: {disturbed} of it was redrawn"
		);

		let settled = settled_frame(session);
		let second_box = run_box(&settled, "second refusal");
		let entrance = changed_fraction(&arriving, &settled, second_box);
		assert!(
			entrance > ARRIVING,
			"while the card that just arrived ran its own entrance: {entrance} of it was redrawn"
		);
		assert!(
			f32::from(second_box.origin.y) > f32::from(resting_box.origin.y),
			"and it is drawn under the one that was already up"
		);
	});
}
