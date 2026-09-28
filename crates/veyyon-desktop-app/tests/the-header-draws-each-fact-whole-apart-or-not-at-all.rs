//! The thread header draws each of its facts whole, clear of everything else
//! in the row, or not at all, and drops them from the end as it narrows.
//!
//! WHY: the facts (directory, machine, branch, pull request, then the
//! session's chips) share one row with the title, the thread's buttons and
//! the window controls. A row that lays every fact out side by side lets one
//! that arrives late, such as the usage a finished turn states, push the
//! branch under the model chip and cut the last chip at the row's edge. The
//! suite drives the real `ThreadHeader` over an `AppState` fed host events,
//! sweeps the window from wide to narrow in steps narrower than any fact,
//! before and after a turn's usage arrives, and reads each text run's bounds
//! against the box the facts are clipped to.
//!
//! Gap: a fact is found by its text run, so a fact drawn only as an icon is
//! not swept. Pixels are not read: a run counts as shown when its bounds meet
//! the facts box, which trusts the box to clip what lies outside it.

use gpui::{AppContext as _, Bounds, Entity, Pixels, TestAppContext, VisualTestContext, px, size};
use veyyon_desktop_app::{AppState, driver, thread::header::ThreadHeader};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionHeaderView, SessionId, SessionStatus,
	SessionSummary, SnapshotSection, Store, TranscriptEntry, Versioned,
	domain::{
		CheckoutView, ContextBreakdownView, HostView, ModelRef, ModelsView, PaceView,
		PullRequestView, UsageView,
	},
	transcript::UsageTotals,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

const TITLE: &str = "Index the repo";
const CWD: &str = "/work/veyyon";
/// Wide enough to hold every fact, in pixels.
const WIDEST: u16 = 2400;
/// Too narrow for any fact beside the title, the buttons and the controls.
const NARROWEST: u16 = 360;
/// Narrower than any fact, so each one leaves at a width of its own.
const STEP: usize = 4;
/// Layout rounding a bound may carry.
const SLACK: f32 = 0.5;

fn sid() -> SessionId {
	SessionId::from("s")
}

/// Session `s` open under `title` with every fact the header states before
/// a turn finishes: its directory, the machine, a dirty branch with a pull
/// request, plan mode, the model and the agent's pace.
fn opened(title: &str) -> Vec<HostEvent> {
	let summary = SessionSummary {
		path:                "/sessions/s.jsonl".to_owned(),
		id:                  sid(),
		workspace:           "ws".to_owned(),
		cwd:                 CWD.to_owned(),
		title:               Some(title.to_owned()),
		parent_path:         None,
		created_at_ms:       0,
		modified_at_ms:      1,
		message_count:       1,
		size_bytes:          1,
		first_message:       None,
		searchable_messages: None,
		status:              SessionStatus::Complete,
	};
	let header = SessionHeaderView {
		id:             sid(),
		schema_version: 1,
		title:          Some(title.to_owned()),
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            CWD.to_owned(),
		mode:           Some("plan".to_owned()),
	};
	let prompt = TranscriptEntry {
		id:                EntryId::from("s-0"),
		parent:            None,
		revision:          1,
		timestamp_ms:      1,
		role:              MessageRole::User,
		content:           vec![ContentBlock::Text { text: "Index the repo.".to_owned() }],
		meta:              None,
		raw_discriminator: String::new(),
		raw:               serde_json::Value::Null,
	};
	let checkout = CheckoutView {
		branch:       "main".to_owned(),
		dirty:        true,
		pull_request: Some(PullRequestView {
			number: 934,
			url:    "https://example.com/pull/934".to_owned(),
		}),
	};
	let models = ModelsView {
		models:          Vec::new(),
		current:         Some(ModelRef {
			provider: "bench".to_owned(),
			id:       "bench-model".to_owned(),
		}),
		thinking_level:  None,
		thinking_levels: Vec::new(),
	};
	let pace = PaceView {
		worked_ms:                125_000,
		working_since_ms:         None,
		tokens_per_second_tenths: Some(423),
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::Sessions(
			Versioned { revision: 1, value: vec![summary] },
			Vec::new(),
		)),
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![prompt],
		})),
		HostEvent::Snapshot(SnapshotSection::Host(HostView {
			hostname: "build.example.net".to_owned(),
		})),
		HostEvent::Snapshot(SnapshotSection::Checkout { session: sid(), checkout: Some(checkout) }),
		HostEvent::Snapshot(SnapshotSection::Models(models)),
		HostEvent::Snapshot(SnapshotSection::Pace { session: sid(), pace }),
	]
}

/// What a finished turn states: the session's usage and its context use.
fn finished_turn() -> Vec<HostEvent> {
	let totals = UsageTotals {
		input_tokens:         123_456,
		output_tokens:        4_567,
		cache_read_tokens:    0,
		cache_write_tokens:   0,
		orchestration_tokens: 0,
		premium_requests:     0,
		cost_microusd:        Some(120_000),
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::Usage(UsageView { session: sid(), totals })),
		HostEvent::Snapshot(SnapshotSection::ContextBreakdown(ContextBreakdownView {
			session:      sid(),
			total_tokens: 84_000,
			limit_tokens: Some(200_000),
			categories:   Vec::new(),
		})),
	]
}

/// A window holding only the header, over session `s` titled `title`.
fn header<'a>(
	app: &'a mut TestAppContext,
	title: &str,
) -> (Entity<AppState>, &'a mut VisualTestContext) {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(opened(title), cx));
	let view_state = state.clone();
	let (_, cx) = app.add_window_view(|window, cx| ThreadHeader::new(view_state, window, cx));
	(state, cx)
}

/// Left, top, right and bottom.
fn edges(bounds: &Bounds<Pixels>) -> [f32; 4] {
	let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
	[x, y, x + f32::from(bounds.size.width), y + f32::from(bounds.size.height)]
}

fn overlap(a: &Bounds<Pixels>, b: &Bounds<Pixels>) -> bool {
	let ([al, at, ar, ab], [bl, bt, br, bb]) = (edges(a), edges(b));
	al < br - SLACK && bl < ar - SLACK && at < bb - SLACK && bt < ab - SLACK
}

fn inside(inner: &Bounds<Pixels>, outer: &Bounds<Pixels>) -> bool {
	let ([il, it, ir, ib], [ol, ot, or, ob]) = (edges(inner), edges(outer));
	il >= ol - SLACK && it >= ot - SLACK && ir <= or + SLACK && ib <= ob + SLACK
}

/// A text run: what it drew and where.
struct Run {
	text:   String,
	bounds: Bounds<Pixels>,
}

/// The header drawn at one width.
struct Frame {
	width:    f32,
	title:    Run,
	/// Every run after the title, in paint order: the facts, shown or not.
	facts:    Vec<Run>,
	clip:     Bounds<Pixels>,
	buttons:  Bounds<Pixels>,
	controls: Option<Bounds<Pixels>>,
}

fn frame(cx: &mut VisualTestContext, width: f32) -> Frame {
	cx.simulate_resize(size(px(width), px(200.0)));
	cx.run_until_parked();
	let mut runs = cx
		.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| Run { text: run.text.to_string(), bounds: run.bounds })
				.collect::<Vec<_>>()
		})
		.into_iter();
	let target = |cx: &mut VisualTestContext, id: &str| {
		cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
	};
	Frame {
		width,
		title: runs.next().expect("the header draws its title first"),
		facts: runs.collect(),
		clip: target(cx, "thread.facts").expect("the facts box is laid out"),
		buttons: target(cx, "thread.buttons").expect("the buttons are laid out"),
		controls: target(cx, "window.controls"),
	}
}

impl Frame {
	/// The facts drawn in the facts box, each checked whole and clear of
	/// the title, the buttons, the controls and every other shown fact.
	fn shown(&self) -> Vec<&str> {
		let width = self.width;
		let mut shown: Vec<&Run> = Vec::new();
		for fact in &self.facts {
			if !overlap(&fact.bounds, &self.clip) {
				continue;
			}
			assert!(
				inside(&fact.bounds, &self.clip),
				"at {width} px {:?} is cut at the edge of the facts box: {:?} in {:?}",
				fact.text,
				fact.bounds,
				self.clip
			);
			for other in &shown {
				assert!(
					!overlap(&fact.bounds, &other.bounds),
					"at {width} px {:?} is drawn over {:?}",
					fact.text,
					other.text
				);
			}
			let neighbours = [
				("the title", Some(self.title.bounds)),
				("the buttons", Some(self.buttons)),
				("the window controls", self.controls),
			];
			for (name, bounds) in neighbours {
				if let Some(bounds) = bounds {
					assert!(
						!overlap(&fact.bounds, &bounds),
						"at {width} px {:?} is drawn over {name}",
						fact.text
					);
				}
			}
			shown.push(fact);
		}
		shown.into_iter().map(|run| run.text.as_str()).collect()
	}
}

/// Every fact at `WIDEST`, then the header swept to `NARROWEST`: each frame
/// shows a leading run of those facts, never more than the wider frame
/// before it, with the title whole while any fact shows, and every count
/// from all of them to none is drawn at some width.
fn sweep(cx: &mut VisualTestContext) -> Vec<String> {
	let widest = frame(cx, f32::from(WIDEST));
	let all: Vec<String> = widest.facts.iter().map(|run| run.text.clone()).collect();
	assert_eq!(widest.shown(), all, "the widest header shows every fact");
	let mut counts = vec![all.len()];
	for width in (NARROWEST..WIDEST).rev().step_by(STEP) {
		let frame = frame(cx, f32::from(width));
		let shown = frame.shown();
		assert_eq!(shown, all[..shown.len()], "at {width} px the facts leave from the end");
		assert!(
			shown.len() <= counts[counts.len() - 1],
			"at {width} px a narrower header shows more facts than a wider one"
		);
		if !shown.is_empty() {
			assert_eq!(frame.title.text, TITLE, "at {width} px a fact narrows the title");
		}
		counts.push(shown.len());
	}
	for count in 0..=all.len() {
		assert!(counts.contains(&count), "no width shows {count} of {all:?}: {counts:?}");
	}
	all
}

#[gpui::test]
fn each_fact_is_drawn_whole_and_apart_or_dropped_from_the_end_before_and_after_a_turn(
	app: &mut TestAppContext,
) {
	let (state, cx) = header(app, TITLE);
	let before = sweep(cx);
	assert_eq!(before.len(), 7, "every fact the fixture sets is drawn: {before:?}");

	// A turn finishes with the header drawn mid-width, as in a window in use.
	frame(cx, 1100.0);
	state.update(cx, |state, cx| state.apply(finished_turn(), cx));
	cx.run_until_parked();
	let after = sweep(cx);
	assert_eq!(after.len(), before.len() + 2, "the turn's usage and context are drawn: {after:?}");
	assert_eq!(after[..before.len()], before, "the facts a turn states join after the others");
}

#[gpui::test]
fn a_title_longer_than_half_the_header_is_cut_there_and_leaves_the_facts_their_room(
	app: &mut TestAppContext,
) {
	let long = ["Rework the session index"; 12].join(" then ");
	let (state, cx) = header(app, &long);
	state.update(cx, |state, cx| state.apply(finished_turn(), cx));
	for width in [1200.0, 1600.0, f32::from(WIDEST)] {
		let frame = frame(cx, width);
		let [left, _, right, _] = edges(&frame.title.bounds);
		assert_ne!(frame.title.text, long, "at {width} px the long title is cut");
		assert!(
			right - left <= width / 2.0 + SLACK,
			"at {width} px the title takes {} px, more than half the header",
			right - left
		);
		assert!(!frame.shown().is_empty(), "at {width} px no fact is drawn beside the long title");
	}
}
