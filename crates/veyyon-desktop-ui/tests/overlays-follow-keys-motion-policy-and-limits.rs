//! Contracts of the overlay primitives, driven through GPUI's test app.
//!
//! WHY: a menu that lands the keyboard highlight on a separator, header or
//! disabled row lets Enter pick nothing or the wrong action; a tab strip that
//! stops at its ends leaves keyboard users stranded; a tab wrapper whose
//! element is dropped leaves the owner with no tab bounds; a popover that
//! animates under reduced motion moves for an operator who turned motion off;
//! a toast stack that grows or never dismisses covers the window.
//!
//! It does not catch pixel geometry (the anchored position, the underline's
//! slide path, the scrollbar thumb), which a headless render covers.

use std::{cell::RefCell, collections::BTreeMap, rc::Rc, time::Duration};

use veyyon_desktop_ui::{
	overlays::{
		Menu, MenuEvent, MenuItem, MenuRow, Popover, Presentation, Tab, TabWrapper, Tabs, TabsEvent,
		Toast, ToastId, ToastKind, Toasts,
	},
	theme::{Appearance, Theme, motion},
};
use veyyon_gpui::{
	Anchor, AnyElement, App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable,
	IntoElement, Pixels, Render, TestAppContext, VisualTestContext, Window, div, point, prelude::*,
	px,
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
