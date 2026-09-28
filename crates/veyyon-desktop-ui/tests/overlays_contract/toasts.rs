//! Lifetime, exit and layout contracts of the toast stack.

use std::time::Duration;

use veyyon_desktop_ui::overlays::{Toast, ToastDismissed, ToastId, ToastKind, Toasts};
use veyyon_gpui::{
	Context, Entity, IntoElement, Modifiers, Render, TestAppContext, VisualTestContext, Window, div,
	prelude::*,
};

use crate::app;

fn shown(toasts: &Entity<Toasts>, cx: &TestAppContext) -> Vec<(ToastId, String)> {
	toasts.read_with(cx, |toasts, _| {
		toasts
			.toasts()
			.map(|(id, toast)| (id, toast.message().to_string()))
			.collect()
	})
}

fn push(toasts: &Entity<Toasts>, cx: &mut TestAppContext, message: &str) -> ToastId {
	let toast = Toast::new(ToastKind::Info, message.to_owned());
	toasts.update(cx, |toasts, cx| toasts.push(toast, cx))
}

#[test]
fn a_fourth_toast_drops_the_oldest() {
	let mut cx = app();
	let toasts = cx.new(|_| Toasts::new());
	let ids: Vec<ToastId> = (0..4)
		.map(|n| push(&toasts, &mut cx, &format!("toast {n}")))
		.collect();
	assert_eq!(shown(&toasts, &cx), vec![
		(ids[1], "toast 1".to_owned()),
		(ids[2], "toast 2".to_owned()),
		(ids[3], "toast 3".to_owned()),
	]);
}

#[test]
fn a_toast_dismisses_itself_after_its_timeout_unless_the_stack_is_hovered() {
	let mut cx = app();
	let toasts = cx.new(|_| Toasts::new());
	let short = Toasts::DISMISS_AFTER.saturating_sub(Duration::from_millis(1));

	push(&toasts, &mut cx, "saved");
	cx.executor().advance_clock(short);
	cx.run_until_parked();
	assert_eq!(shown(&toasts, &cx).len(), 1, "still shown just before the timeout");
	cx.executor().advance_clock(Duration::from_millis(1));
	cx.run_until_parked();
	assert!(shown(&toasts, &cx).is_empty(), "gone at the timeout");

	push(&toasts, &mut cx, "held");
	toasts.update(&mut cx, |toasts, cx| toasts.pause(true, cx));
	cx.executor().advance_clock(Toasts::DISMISS_AFTER * 3);
	cx.run_until_parked();
	assert_eq!(shown(&toasts, &cx).len(), 1, "a hovered stack keeps its toasts");
	toasts.update(&mut cx, |toasts, cx| toasts.pause(false, cx));
	cx.executor().advance_clock(short);
	cx.run_until_parked();
	assert_eq!(shown(&toasts, &cx).len(), 1, "leaving the stack restarts the full timeout");
	cx.executor().advance_clock(Duration::from_millis(1));
	cx.run_until_parked();
	assert!(shown(&toasts, &cx).is_empty(), "gone a full timeout after the pointer left");
}

#[test]
fn a_toast_lasts_what_its_owner_gives_it_and_without_a_lifetime_stays_until_dismissed() {
	let mut cx = app();
	let toasts = cx.new(|_| Toasts::new());
	let lasts = Duration::from_secs(2);
	let before = Duration::from_millis(1_999);
	let brief = Toast::new(ToastKind::Info, "brief").lasts(Some(lasts));
	let brief = toasts.update(&mut cx, |toasts, cx| toasts.push(brief, cx));
	let kept = Toast::new(ToastKind::Error, "kept").lasts(None);
	let kept = toasts.update(&mut cx, |toasts, cx| toasts.push(kept, cx));
	let ids = |cx: &TestAppContext| -> Vec<ToastId> {
		shown(&toasts, cx).into_iter().map(|(id, _)| id).collect()
	};

	cx.executor().advance_clock(before);
	cx.run_until_parked();
	assert_eq!(ids(&cx), vec![brief, kept], "both shown just before the brief one's time");
	cx.executor().advance_clock(Duration::from_millis(1));
	cx.run_until_parked();
	assert_eq!(ids(&cx), vec![kept], "the brief one goes at its own time");
	cx.executor().advance_clock(Toasts::DISMISS_AFTER * 3);
	cx.run_until_parked();
	assert_eq!(ids(&cx), vec![kept], "no timeout takes down a toast without a lifetime");
	toasts.update(&mut cx, |toasts, cx| toasts.dismiss(kept, cx));
	assert!(ids(&cx).is_empty(), "dismissing it takes it down");
}

/// A window that draws a toast stack and records what it emits.
struct Stage {
	toasts: Entity<Toasts>,
	events: Vec<ToastDismissed>,
}

impl Render for Stage {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		div().relative().size_full().child(self.toasts.clone())
	}
}

fn stage(cx: &mut TestAppContext) -> (Entity<Toasts>, Entity<Stage>, &mut VisualTestContext) {
	let (stage, cx) = cx.add_window_view(|_, cx| {
		let toasts = cx.new(|_| Toasts::new());
		cx.subscribe(&toasts, |stage: &mut Stage, _, event: &ToastDismissed, _| {
			stage.events.push(*event);
		})
		.detach();
		Stage { toasts, events: Vec::new() }
	});
	let toasts = stage.read_with(cx, |stage, _| stage.toasts.clone());
	(toasts, stage, cx)
}

/// Delivers a frame every 16 ms while the window requests one, and returns
/// how many it delivered.
fn serve_frames(cx: &mut VisualTestContext) -> usize {
	let mut served = 0;
	loop {
		cx.executor().advance_clock(Duration::from_millis(16));
		if cx.update(|window, cx| window.simulate_next_frame(cx)) == 0 {
			return served;
		}
		served += 1;
		assert!(served < 120, "the window never stops requesting frames");
		cx.run_until_parked();
	}
}

#[test]
fn the_stack_reports_a_toast_it_took_down_itself_and_not_one_its_owner_dismissed() {
	let mut cx = app();
	cx.update(|cx| cx.set_reduce_motion(true));
	let (toasts, stage, cx) = stage(&mut cx);
	let expired = toasts.update(cx, |toasts, cx| toasts.push(Toast::new(ToastKind::Info, "a"), cx));
	cx.executor().advance_clock(Toasts::DISMISS_AFTER);
	cx.run_until_parked();
	let told = Toast::new(ToastKind::Info, "b").lasts(None);
	let told = toasts.update(cx, |toasts, cx| toasts.push(told, cx));
	toasts.update(cx, |toasts, cx| toasts.dismiss(told, cx));
	let closed = Toast::new(ToastKind::Info, "c").lasts(None);
	let closed = toasts.update(cx, |toasts, cx| toasts.push(closed, cx));
	cx.run_until_parked();

	let close = cx
		.debug_bounds("toast-close")
		.expect("the close button is drawn");
	cx.simulate_click(close.center(), Modifiers::none());
	cx.run_until_parked();
	assert_eq!(stage.read_with(cx, |stage, _| stage.events.clone()), vec![
		ToastDismissed(expired),
		ToastDismissed(closed),
	]);
	assert!(shown(&toasts, cx).is_empty(), "the close button takes its toast down");
}

/// A message with no break in it wraps inside its toast; one that widens the
/// toast instead pushes the action and the close button past the window edge,
/// where no click reaches them.
#[test]
fn a_toast_keeps_its_buttons_in_the_window_however_long_its_message() {
	let mut cx = app();
	let (toasts, _stage, cx) = stage(&mut cx);
	let message = format!("/{}", "segment/".repeat(40));
	let toast = Toast::new(ToastKind::Info, message).action("Open", |_, _| {});
	toasts.update(cx, |toasts, cx| toasts.push(toast.lasts(None), cx));
	cx.run_until_parked();
	let width = cx.update(|window, _| window.viewport_size().width);
	let close = cx
		.debug_bounds("toast-close")
		.expect("the close button is drawn");
	assert!(close.right() <= width, "the close button ends at {close:?} in a {width:?} window");
}

/// Takes down a shown toast and returns the opacity it draws with right
/// after, and how many frames the window requests before it is at rest.
fn take_down(reduce_motion: bool) -> (Option<f32>, usize) {
	let mut cx = app();
	cx.update(|cx| cx.set_reduce_motion(reduce_motion));
	let (toasts, _stage, cx) = stage(&mut cx);
	let id = Toast::new(ToastKind::Info, "a").lasts(None);
	let id = toasts.update(cx, |toasts, cx| toasts.push(id, cx));
	cx.run_until_parked();
	serve_frames(cx);
	toasts.update(cx, |toasts, cx| toasts.dismiss(id, cx));
	let first = toasts.read_with(cx, |toasts, cx| toasts.opacity(id, cx));
	cx.run_until_parked();
	let frames = serve_frames(cx);
	assert_eq!(
		toasts.read_with(cx, |toasts, cx| toasts.opacity(id, cx)),
		None,
		"nothing of the toast is drawn once the window is at rest"
	);
	(first, frames)
}

#[test]
fn a_toast_taken_down_under_reduced_motion_goes_on_the_next_frame() {
	assert_eq!(take_down(true), (None, 0));
}

#[test]
fn a_toast_taken_down_fades_out_over_frames_and_the_window_then_rests() {
	let (first, frames) = take_down(false);
	assert!(first.is_some_and(|opacity| opacity > 0.99), "the exit starts fully shown: {first:?}");
	assert!(frames > 1, "the exit runs over several frames, not one: {frames}");
}
