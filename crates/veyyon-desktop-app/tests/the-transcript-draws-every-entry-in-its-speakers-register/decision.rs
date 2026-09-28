//! A plan card draws its title as words, once, and never the markdown the
//! plan was written in.
//!
//! WHY: the card's title was the plan's first line with leading `#` marks
//! trimmed, so emphasis drew its asterisks and underscores, and the body drew
//! the whole plan again, so the title line was drawn twice. The sweep covers
//! each form a first line takes: an ATX heading, a setext heading and prose
//! with inline markup.
//!
//! Gap: the body's own markdown is the renderer's and is not read here, past
//! the absence of the title line from it.

use gpui::TestAppContext;
use veyyon_desktop_model::{HostEvent, PendingDecisions, PlanInteraction, SnapshotSection};

use super::{opened, sid, thread};

fn pending_plan(markdown: &str) -> HostEvent {
	let plan = PlanInteraction {
		id:              "p".into(),
		markdown_plan:   markdown.to_owned(),
		requested_at_ms: 1,
	};
	let pending = PendingDecisions {
		approvals: Vec::new(),
		questions: Vec::new(),
		plans:     vec![plan],
		dialogs:   Vec::new(),
	};
	HostEvent::Snapshot(SnapshotSection::Interactions { session: sid(), pending })
}

#[gpui::test]
fn a_plan_title_is_drawn_once_as_words_whatever_markdown_it_arrived_in(cx: &mut TestAppContext) {
	let plans = [
		("# Ship the fix\n\nMove the parser.", "Ship the fix"),
		("Ship the fix\n============\n\nMove the parser.", "Ship the fix"),
		("**Ship** the _fix_ `now`\n\nMove the parser.", "Ship the fix now"),
	];
	for (markdown, title) in plans {
		let mut events = opened(Vec::new());
		events.push(pending_plan(markdown));
		let mut thread = thread(cx, events);
		assert_eq!(thread.drew_times(title), 1, "the title of {markdown:?} is drawn once");
		assert!(thread.drew("Move the parser."), "the body of {markdown:?} is drawn");
		let marked: Vec<String> = thread
			.runs()
			.into_iter()
			.map(|(run, _)| run)
			.filter(|run| run.contains(['#', '*', '_', '`', '=']))
			.collect();
		assert_eq!(marked, Vec::<String>::new(), "no markdown syntax is drawn for {markdown:?}");
	}
}
