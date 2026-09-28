//! The toast stack sits under the thread header, clear of the composer at the
//! foot of the thread column and the drawer under it.
//!
//! WHY: a stack placed against the window's bottom right covered the
//! composer's controls whenever the thread column was narrower than the
//! composer and a toast side by side, and covered the drawer while it was
//! open. The class closed here is the stack's place following the strips that
//! top the thread column: with the banner, the freeze strip, both and neither
//! drawn, and with the panel closed and open, the stack starts below the
//! thread header and ends in the upper half of the thread column.
//!
//! Gap: one toast is drawn, so a full stack taller than half the column is not
//! asserted. The thread is a stub region here; its composer's drawn height is
//! the thread suite's subject.

use gpui::{Bounds, Pixels, TestAppContext, VisualTestContext};
use veyyon_desktop_model::{
	AgentPauseView, ConnectionState, HostEvent, NotificationPriority as Priority,
	NotificationSource as Source, PanelsStore, SnapshotSection,
};
use veyyon_desktop_ui::theme::size;

use super::{announce, drawn, note, open_laid_out, raised_at, remembering};

/// The link up, or down with the banner drawn.
fn link(up: bool) -> HostEvent {
	HostEvent::ConnectionChanged(if up {
		ConnectionState::Connected { endpoint: "local".to_owned(), protocol: 1 }
	} else {
		ConnectionState::Detached
	})
}

/// The host stating every agent frozen, or running.
const fn frozen(paused: bool) -> HostEvent {
	let view = if paused {
		AgentPauseView { paused: true, since_ms: None }
	} else {
		AgentPauseView::RUNNING
	};
	HostEvent::Snapshot(SnapshotSection::AgentPause(view))
}

/// Where `selector` is drawn once every view is redrawn.
fn bounds(cx: &mut VisualTestContext, selector: &'static str) -> Bounds<Pixels> {
	cx.update(|window, _| window.refresh());
	cx.debug_bounds(selector)
		.unwrap_or_else(|| panic!("`{selector}` is drawn"))
}

#[test]
fn the_stack_sits_under_the_thread_header_in_the_upper_half_of_the_thread_column() {
	for panel in [false, true] {
		for (banner, freeze) in [(false, false), (true, false), (false, true), (true, true)] {
			let arm = format!("panel {panel}, banner {banner}, freeze {freeze}");
			let mut cx = TestAppContext::single();
			let panels = PanelsStore {
				right_panel_visible: panel,
				drawer_visible: true,
				..PanelsStore::default()
			};
			let (app, _, cx) = open_laid_out(&mut cx, remembering("s1"), panels);
			app.update(cx, |app, cx| app.apply(vec![link(true), frozen(freeze), link(!banner)], cx));
			cx.run_until_parked();
			assert_eq!(drawn(cx, "connection-banner"), banner, "{arm}: the banner");
			assert_eq!(drawn(cx, "freeze"), freeze, "{arm}: the freeze strip");
			let at = raised_at();
			announce(&app, cx, note("ask", Source::DecisionWaiting, Priority::Urgent, "decision", at));

			let thread = bounds(cx, "thread-region");
			let drawer = bounds(cx, "drawer-region");
			let close = bounds(cx, "toast-close");
			assert!(
				close.top() >= thread.top() + size::HEADER,
				"{arm}: the stack at {close:?} starts below the header of the thread at {thread:?}"
			);
			assert!(
				close.bottom() <= thread.top() + thread.size.height / 2.,
				"{arm}: the stack at {close:?} ends in the upper half of the thread at {thread:?}"
			);
			assert!(close.bottom() < drawer.top(), "{arm}: the stack at {close:?} clears the drawer");
		}
	}
}
