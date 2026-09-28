//! The freeze strip tops whatever view the thread column holds while the host
//! states every agent frozen, and leaves when the host states them running.
//!
//! WHY: the freeze belongs to the host process, not to a session. A strip the
//! thread drew alone vanished whenever settings or the empty state took the
//! thread's place, and the window looked free while every turn waited. The
//! class closed here is the strip following the view instead of the host:
//! each view the column holds is opened, the host states a freeze, and the
//! strip must be drawn on that frame, above the view, and gone on the frame
//! the host resumes. In each view Resume is pressed while the host withholds
//! the lifecycle, which sends nothing, and once the host grants it, which
//! sends one `ResumeAgents`.
//!
//! Gap: a new view the column holds is swept only once `View` holds it. The
//! strip's duration words are not read, and the thread header's own freeze
//! control is the composer suite's subject.

use gpui::{Bounds, Entity, Pixels, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{AppState, actions::workspace as act, driver};
use veyyon_desktop_model::{
	AgentPauseView, Capability, CapabilityStatus, ConnectionState, HostAction, HostEvent,
	SnapshotSection,
};

use super::{click, open, open_over, remembering, sent};

/// A view the thread column holds.
#[derive(Clone, Copy, Debug)]
enum View {
	/// The thread of the open session.
	Thread,
	/// Settings, in the thread's place.
	Settings,
	/// The empty state, while no session is open.
	Empty,
}

impl View {
	const ALL: [Self; 3] = [Self::Thread, Self::Settings, Self::Empty];

	/// Opens a window whose thread column holds this view.
	fn open(self, cx: &mut TestAppContext) -> (Entity<AppState>, &mut VisualTestContext) {
		driver::enable();
		let (app, _, cx) = match self {
			Self::Thread => open_over(cx, remembering("s1")),
			Self::Settings | Self::Empty => open(cx),
		};
		if matches!(self, Self::Settings) {
			cx.update(|window, cx| {
				window.dispatch_action(Box::new(act::OpenSettings::default()), cx);
			});
			cx.run_until_parked();
		}
		(app, cx)
	}

	/// Where this view is drawn in the frame on screen.
	fn bounds(self, cx: &mut VisualTestContext) -> Option<Bounds<Pixels>> {
		match self {
			Self::Thread => cx.debug_bounds("thread-region"),
			Self::Settings => target(cx, "settings"),
			Self::Empty => target(cx, "empty"),
		}
	}
}

/// Where the driver target `id` is drawn in the frame on screen.
fn target(cx: &mut VisualTestContext, id: &str) -> Option<Bounds<Pixels>> {
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
}

/// Redraws every view, then reads where the strip and `view` are drawn.
fn frame(
	view: View,
	cx: &mut VisualTestContext,
) -> (Option<Bounds<Pixels>>, Option<Bounds<Pixels>>) {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	(cx.debug_bounds("freeze"), view.bounds(cx))
}

fn apply(app: &Entity<AppState>, cx: &mut VisualTestContext, events: Vec<HostEvent>) {
	app.update(cx, |app, cx| app.apply(events, cx));
	cx.run_until_parked();
}

/// The link up.
fn up() -> HostEvent {
	HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "local".to_owned(),
		protocol: 1,
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

/// The host granting the lifecycle, or withholding it for `reason`.
fn lifecycle(reason: Option<&str>) -> HostEvent {
	let status = reason.map_or(CapabilityStatus::Available, |reason| {
		CapabilityStatus::Unavailable { reason: reason.to_owned() }
	});
	HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(Capability::Lifecycle, status)]))
}

#[test]
fn the_strip_tops_every_view_the_column_holds_from_the_freeze_until_the_resume() {
	for view in View::ALL {
		let mut cx = TestAppContext::single();
		let (app, cx) = view.open(&mut cx);
		apply(&app, cx, vec![up()]);
		let (strip, free) = frame(view, cx);
		assert_eq!(strip, None, "{view:?}: no strip is drawn while agents run");
		let free = free.unwrap_or_else(|| panic!("{view:?} is drawn"));

		apply(&app, cx, vec![frozen(true)]);
		assert!(
			cx.debug_bounds("freeze").is_some(),
			"{view:?}: the strip is drawn on the frame the host states the freeze"
		);
		let (strip, held) = frame(view, cx);
		let strip = strip.unwrap_or_else(|| panic!("{view:?}: the strip is drawn"));
		let held = held.unwrap_or_else(|| panic!("{view:?} is drawn under the strip"));
		assert!(strip.bottom() <= held.top(), "{view:?}: the strip {strip:?} tops the view {held:?}");

		apply(&app, cx, vec![frozen(false)]);
		assert!(
			cx.debug_bounds("freeze").is_none(),
			"{view:?}: the strip leaves on the frame the host resumes"
		);
		let (strip, resumed) = frame(view, cx);
		assert_eq!(strip, None, "{view:?}: no strip is drawn once agents run");
		assert_eq!(resumed, Some(free), "{view:?}: the view takes back the strip's room");
	}
}

#[test]
fn resume_sends_one_resume_agents_only_while_the_host_grants_the_lifecycle() {
	for view in View::ALL {
		let mut cx = TestAppContext::single();
		let (app, cx) = view.open(&mut cx);
		apply(&app, cx, vec![up(), lifecycle(Some("this host runs no agents")), frozen(true)]);
		let _opened = sent(&app, cx);

		click(cx, "freeze-resume");
		assert_eq!(
			sent(&app, cx),
			Vec::<HostAction>::new(),
			"{view:?}: a withheld lifecycle takes no Resume"
		);

		apply(&app, cx, vec![lifecycle(None)]);
		click(cx, "freeze-resume");
		assert_eq!(
			sent(&app, cx),
			[HostAction::ResumeAgents],
			"{view:?}: a granted lifecycle takes one Resume"
		);
	}
}
