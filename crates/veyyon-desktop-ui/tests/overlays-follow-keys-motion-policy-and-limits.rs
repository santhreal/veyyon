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
//! window drawing frames.
//!
//! It does not catch pixel geometry (the anchored position, the underline's
//! slide path, the scrollbar thumb), which a headless render covers.

use std::{cell::RefCell, collections::BTreeMap, rc::Rc, time::Duration};

use veyyon_desktop_ui::{
	overlays::{
		Menu, MenuEvent, MenuItem, MenuRow, Popover, Presentation, Tab, TabWrapper, Tabs, TabsEvent,
		Toast, ToastDismissed, ToastId, ToastKind, Toasts,
	},
	theme::{Appearance, Theme, motion},
};
use veyyon_gpui::{
	Anchor, AnyElement, App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable,
	IntoElement, Modifiers, Pixels, Render, TestAppContext, VisualTestContext, Window, div, point,
	prelude::*, px,
};

fn app() -> TestAppContext {
	let cx = TestAppContext::single();
	cx.update(|cx| Theme::install(Appearance::Dark, cx)).expect("the embedded dark palette parses");
	cx
}

/// A window root that shows one focused entity and records what it emits.
struct Host<V, E> {
	child:  Entity<V>,
	events: Vec<E>,
}

impl<V: Render, E: 'static> Render for Host<V, E> {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		div().size_full().child(self.child.clone())
	}
}

fn host<V, E>(
	cx: &mut TestAppContext,
	build: impl FnOnce(&mut Context<Host<V, E>>) -> Entity<V>,
) -> (Entity<Host<V, E>>, &mut VisualTestContext)
where
	V: Render + Focusable + EventEmitter<E>,
	E: Clone + 'static,
{
	cx.add_window_view(|window, cx| {
		let child = build(cx);
		window.focus(&child.focus_handle(cx), cx);
		cx.subscribe(&child, |host: &mut Host<V, E>, _, event: &E, _| host.events.push(event.clone()))
			.detach();
		Host { child, events: Vec::new() }
	})
}

fn menu_items() -> Vec<MenuItem> {
	vec![
		MenuRow::new("Open").into(),
		MenuRow::new("Rename").hint("F2").disabled(true).into(),
		MenuItem::Separator,
		MenuItem::header("Danger"),
		MenuRow::new("Delete").hint("Del").into(),
	]
}

fn highlighted(host: &Entity<Host<Menu, MenuEvent>>, cx: &VisualTestContext) -> Option<usize> {
	host.read_with(cx, |host, cx| host.child.read(cx).highlighted())
}

#[test]
fn menu_arrows_land_only_on_enabled_rows_and_enter_picks_the_highlighted_one() {
	let mut cx = app();
	let (host, cx) = host(&mut cx, |cx| cx.new(|cx| Menu::new(menu_items(), cx)));
	let steps = [
		("down", Some(0)),
		("down", Some(4)),
		("down", Some(0)),
		("up", Some(4)),
		("up", Some(0)),
		("end", Some(4)),
		("home", Some(0)),
		("d", Some(4)),
	];
	for (key, expected) in steps {
		cx.simulate_keystrokes(key);
		assert_eq!(highlighted(&host, cx), expected, "after {key}");
	}
	cx.simulate_keystrokes("enter");
	assert_eq!(host.read_with(cx, |host, _| host.events.clone()), vec![MenuEvent::Picked(4)]);
}

#[test]
fn menu_escape_dismisses_without_picking() {
	let mut cx = app();
	let (host, cx) = host(&mut cx, |cx| cx.new(|cx| Menu::new(menu_items(), cx)));
	cx.simulate_keystrokes("down escape");
	assert_eq!(host.read_with(cx, |host, _| host.events.clone()), vec![MenuEvent::Dismissed]);
}

#[test]
fn tab_arrows_wrap_at_either_end_and_report_the_new_tab() {
	let mut cx = app();
	cx.update(|cx| cx.set_reduce_motion(true));
	let tabs = || vec![Tab::new("Diff"), Tab::new("Files"), Tab::new("Agents").closable(true)];
	let (host, cx) = host(&mut cx, |cx| cx.new(|cx| Tabs::new(tabs(), 2, cx)));
	cx.simulate_keystrokes("right");
	assert_eq!(host.read_with(cx, |host, cx| host.child.read(cx).selected()), 0);
	cx.simulate_keystrokes("left");
	assert_eq!(host.read_with(cx, |host, cx| host.child.read(cx).selected()), 2);
	assert_eq!(
		host.read_with(cx, |host, _| host.events.clone()),
		vec![TabsEvent::Selected(0), TabsEvent::Selected(2)]
	);
}

#[test]
fn a_tab_wrapper_receives_every_tab_and_its_element_is_the_one_laid_out() {
	let mut cx = app();
	let laid_out: Rc<RefCell<BTreeMap<usize, Bounds<Pixels>>>> = Rc::default();
	let sink = Rc::clone(&laid_out);
	let wrap: TabWrapper = Rc::new(move |ix, tab: AnyElement| {
		let sink = Rc::clone(&sink);
		div()
			.child(tab)
			.on_children_prepainted(move |bounds, _, _| {
				if let Some(&tab) = bounds.first() {
					sink.borrow_mut().insert(ix, tab);
				}
			})
			.into_any_element()
	});
	let tabs = vec![Tab::new("Diff"), Tab::new("Files"), Tab::new("Agents")];
	let (_host, cx) = host::<Tabs, TabsEvent>(&mut cx, |cx| {
		cx.new(|cx| {
			let mut strip = Tabs::new(tabs, 0, cx);
			strip.set_tab_wrapper(Some(wrap), cx);
			strip
		})
	});
	cx.run_until_parked();
	let laid_out = laid_out.borrow();
	assert_eq!(laid_out.keys().copied().collect::<Vec<_>>(), vec![0, 1, 2]);
	let lefts: Vec<Pixels> = laid_out.values().map(Bounds::left).collect();
	assert!(lefts.windows(2).all(|pair| pair[0] < pair[1]), "tabs lie left to right: {lefts:?}");
}

/// Content a popover focuses while open.
struct Surface {
	focus: FocusHandle,
}

impl Focusable for Surface {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for Surface {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		div().track_focus(&self.focus).child("content")
	}
}

/// Opens a popover and returns what its first frame draws.
fn first_frame_after_open(reduce_motion: bool) -> Presentation {
	let mut cx = app();
	cx.update(|cx| cx.set_reduce_motion(reduce_motion));
	let (popover, cx) = cx.add_window_view(|_, cx| {
		let content = cx.new(|cx| Surface { focus: cx.focus_handle() });
		Popover::new(&content, cx)
	});
	popover.update_in(cx, |popover, window, cx| {
		popover.open(point(px(40.0), px(40.0)), Anchor::TopLeft, None, window, cx);
	});
	popover.read_with(cx, |popover, cx| popover.presentation(cx))
}

#[test]
fn a_popover_under_reduced_motion_draws_its_first_frame_fully_open() {
	assert_eq!(first_frame_after_open(true), Presentation { opacity: 1.0, scale: 1.0 });
	let animated = first_frame_after_open(false);
	assert!(animated.opacity < 1e-3, "the animated first frame is transparent: {animated:?}");
	assert!(
		(animated.scale - motion::POPOVER_SCALE).abs() < 1e-4,
		"the animated first frame starts scaled down: {animated:?}"
	);
}

fn shown(toasts: &Entity<Toasts>, cx: &TestAppContext) -> Vec<(ToastId, String)> {
	toasts.read_with(cx, |toasts, _| {
		toasts.toasts().map(|(id, toast)| (id, toast.message().to_string())).collect()
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
	let ids: Vec<ToastId> = (0..4).map(|n| push(&toasts, &mut cx, &format!("toast {n}"))).collect();
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

	let close = cx.debug_bounds("toast-close").expect("the close button is drawn");
	cx.simulate_click(close.center(), Modifiers::none());
	cx.run_until_parked();
	assert_eq!(stage.read_with(cx, |stage, _| stage.events.clone()), vec![
		ToastDismissed(expired),
		ToastDismissed(closed),
	]);
	assert!(shown(&toasts, cx).is_empty(), "the close button takes its toast down");
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
