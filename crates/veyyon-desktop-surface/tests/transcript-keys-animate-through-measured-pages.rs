//! WHY: Keyboard scrolling previously stopped at measured rows or bypassed
//! motion. Exercise real pointer focus and all four transcript navigation keys
//! with both virtualized history and a multi-screen response. X11 capture
//! separately checks native event delivery and displayed animation cadence.

use std::{path::Path, time::Duration};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Block, Keymap, ShellState, ShellView, Turn, attach::ConnectionPhase, install_tokens,
};
use veyyon_gpui::{AppContext, PlatformInput, ScrollDelta, ScrollWheelEvent, point, px};

fn offset(session: &mut HeadlessSession<'_, ShellView>) -> f32 {
	session
		.update(|view, _, _| {
			-f32::from(
				view
					.transcript_viewport()
					.list_state()
					.scroll_px_offset_for_scrollbar()
					.y,
			)
		})
		.expect("measured offset")
}

fn settle(session: &mut HeadlessSession<'_, ShellView>) {
	for _ in 0..20 {
		session.advance(Duration::from_millis(50));
		session.frame().expect("animation frame");
	}
}

#[test]
fn transcript_keys_animate_through_measured_pages() {
	for long_response in [false, true] {
		let mut cx = headless_context().expect("headless context");
		let tokens = load_bundled_tokens().expect("tokens");
		let theme = load_bundled_theme("dark").expect("theme");
		let transcript = if long_response {
			vec![Turn::Operator("Describe text editors.".into()), Turn::Agent {
				blocks: vec![Block::Prose("Editors support text editing.\n\n".repeat(80))],
				model:  None,
			}]
		} else {
			(0..60)
				.map(|i| Turn::Operator(format!("Question {i}: describe text editing and navigation.")))
				.collect()
		};
		let state =
			ShellState { connection: ConnectionPhase::Attached, transcript, ..ShellState::default() };
		let options =
			RenderOptions { width: 1180, height: 800, scale_factor: 1.0, ..RenderOptions::default() };
		let mut session = HeadlessSession::open(&mut cx, &options, move |_, app| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("install tokens");
			app.bind_keys(Keymap::default().bindings());
			app.new(|_| ShellView::new(installed, state))
		})
		.expect("session opens");
		session.frame().expect("initial frame");
		let bounds = session
			.update(|view, _, _| view.transcript_viewport().list_state().viewport_bounds())
			.expect("viewport bounds");
		assert!(f32::from(bounds.size.height) > 0.0);
		session
			.click(point(bounds.origin.x + px(12.0), bounds.origin.y + px(12.0)))
			.expect("pointer focuses transcript");
		session.frame().expect("focused frame");
		assert!(session.keystroke("home").expect("Home"));
		session.frame().expect("start Home");
		settle(&mut session);
		let top = session
			.update(|view, _, _| view.transcript_viewport().logical_scroll_top())
			.expect("head anchor");
		assert_eq!(top.item_ix, 0);
		assert_eq!(top.offset_in_item, px(0.0));
		assert!(session.keystroke("pagedown").expect("PageDown"));
		session.frame().expect("start PageDown");
		assert_eq!(offset(&mut session), 0.0, "PageDown must animate rather than jump");
		session.advance(Duration::from_millis(60));
		session.frame().expect("intermediate page");
		let middle = offset(&mut session);
		assert!(
			middle > 0.0 && middle < f32::from(bounds.size.height),
			"intermediate offset {middle}"
		);
		settle(&mut session);
		let page = offset(&mut session);
		assert!(
			(page - f32::from(bounds.size.height)).abs() < 1.0,
			"page={page}, viewport={:?}",
			bounds.size.height
		);
		assert!(session.keystroke("pageup").expect("PageUp"));
		session.frame().expect("start PageUp");
		settle(&mut session);
		let top = session
			.update(|view, _, _| view.transcript_viewport().logical_scroll_top())
			.expect("returned head anchor");
		assert_eq!(top.item_ix, 0);
		assert_eq!(top.offset_in_item, px(0.0));
		assert!(session.keystroke("pagedown").expect("interrupted PageDown"));
		session.frame().expect("start interrupted page");
		session.advance(Duration::from_millis(60));
		session.frame().expect("page before manual wheel");
		let before_wheel = offset(&mut session);
		session
			.update(|_, window, cx| {
				window.dispatch_event(
					PlatformInput::ScrollWheel(ScrollWheelEvent {
						position: point(bounds.origin.x + px(12.0), bounds.origin.y + px(12.0)),
						delta: ScrollDelta::Pixels(point(px(0.0), px(30.0))),
						..Default::default()
					}),
					cx,
				);
			})
			.expect("native wheel event");
		session.frame().expect("manual wheel frame");
		let manual = offset(&mut session);
		assert!(manual < before_wheel, "upward wheel must move the transcript");
		settle(&mut session);
		assert_eq!(offset(&mut session), manual, "animation must not overwrite manual scrolling");
		assert!(session.keystroke("end").expect("End"));
		session.frame().expect("start End");
		settle(&mut session);
		assert!(
			session
				.update(|view, _, _| view.transcript_viewport().is_following_tail())
				.expect("tail following restored")
		);
	}
}
