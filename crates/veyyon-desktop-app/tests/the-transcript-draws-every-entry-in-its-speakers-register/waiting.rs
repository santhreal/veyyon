//! A turn that waits on a decision the operator has not made is still
//! running: its calls stay drawn, no model foots it and no Retry or Rephrase
//! is offered under it, until the decision leaves.
//!
//! WHY: the window read a turn as running only while a reply streamed or the
//! host reported a working window. A turn waiting on an approval folded its
//! calls under `Worked for`, drew the call it waited on as aborted and footed
//! itself with its model while the dock asked whether to run that call. The
//! sweep sends one pending decision of each queue `PendingDecisions` holds,
//! once with the transcript the window opens on and once after the window
//! drew the turn finished; the queues are split out of one value by a
//! pattern that names every field, so a queue added to the model does not
//! compile here until it states its decision. Each decision is then
//! withdrawn and the turn folds.
//!
//! Gap: the dock's card for each decision is the dock's suite; a decision
//! pending in another session is not sent here.

use gpui::TestAppContext;
use veyyon_desktop_model::{
	ApprovalInteraction, ContentBlock, DialogInteraction, DialogOption, DialogQuestion, HostEvent,
	MessageRole, PendingDecisions, PlanInteraction, QuestionInteraction, SnapshotSection,
};

use super::{
	Thread,
	actions::offered,
	entry,
	items::{drawn_by, forms},
	opened, sid, text, thread,
	turns::named,
};

const MODEL: &str = "bench-model";

/// The host stating the decisions the session waits on.
fn waiting_on(pending: PendingDecisions) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Interactions { session: sid(), pending })
}

/// One pending decision of each queue, named by the queue it sits in.
fn one_in_each_queue() -> Vec<(&'static str, PendingDecisions)> {
	let PendingDecisions { approvals, questions, plans, dialogs } = PendingDecisions {
		approvals: vec![ApprovalInteraction {
			id:              "approve".into(),
			tool_name:       "read".to_owned(),
			detail:          "Path: src/lib.rs".to_owned(),
			requested_at_ms: 1,
		}],
		questions: vec![QuestionInteraction {
			id:              "ask".into(),
			prompt:          "Which file?".to_owned(),
			options:         vec!["lib".to_owned(), "main".to_owned()],
			requested_at_ms: 1,
		}],
		plans:     vec![PlanInteraction {
			id:              "plan".into(),
			markdown_plan:   "# Move the parser".to_owned(),
			requested_at_ms: 1,
		}],
		dialogs:   vec![DialogInteraction {
			id:              "dialog".into(),
			questions:       vec![DialogQuestion {
				id:          "scope".to_owned(),
				question:    "Which scope?".to_owned(),
				header:      None,
				options:     vec![DialogOption {
					label:       "All".to_owned(),
					description: None,
					preview:     None,
				}],
				multi:       false,
				recommended: None,
				preselected: Vec::new(),
			}],
			requested_at_ms: 1,
			expires_at_ms:   None,
		}],
	};
	vec![
		("approval", PendingDecisions { approvals, ..PendingDecisions::new() }),
		("question", PendingDecisions { questions, ..PendingDecisions::new() }),
		("plan", PendingDecisions { plans, ..PendingDecisions::new() }),
		("dialog", PendingDecisions { dialogs, ..PendingDecisions::new() }),
	]
}

/// A prompt and the reply whose `read` call waits on the operator.
fn waiting_turn() -> Vec<HostEvent> {
	let call = ContentBlock::ToolCall {
		id:           "c".to_owned(),
		name:         "read".to_owned(),
		arguments:    serde_json::json!({ "path": "src/lib.rs" }),
		presentation: None,
	};
	opened(vec![
		entry("u1", None, MessageRole::User, vec![text("read the parser")]),
		named(entry("a1", Some("u1"), MessageRole::Assistant, vec![text("reading"), call]), MODEL),
	])
}

/// What the reply's item shows: the pieces it is planned as, whether it drew
/// the fold row, its model footer and its call row, and where Retry or
/// Rephrase is offered.
#[derive(Debug, PartialEq, Eq)]
struct Seen {
	planned: Vec<String>,
	folded:  bool,
	footed:  bool,
	call:    bool,
	offered: Vec<String>,
}

fn seen(thread: &mut Thread<'_>) -> Seen {
	let planned = forms(thread, 1);
	let words = drawn_by(thread, "a1");
	Seen {
		planned,
		folded: words.iter().any(|word| word.starts_with("▸ Worked for")),
		footed: words.iter().any(|word| word == MODEL),
		call: words.iter().any(|word| word == "Read"),
		offered: offered(thread),
	}
}

#[gpui::test]
fn a_turn_waiting_on_a_decision_of_any_kind_runs_until_the_decision_leaves(
	cx: &mut TestAppContext,
) {
	let running = Seen {
		planned: vec!["prose #0".to_owned(), "tool c Running: Read src/lib.rs".to_owned()],
		folded:  false,
		footed:  false,
		call:    true,
		offered: Vec::new(),
	};
	let finished = Seen {
		planned: vec![
			"prose #0".to_owned(),
			"worked from 0: Worked for 0s · 1 step (open)".to_owned(),
			"tool c Aborted: Read src/lib.rs".to_owned(),
			format!("footer: {MODEL}"),
		],
		folded:  true,
		footed:  true,
		call:    false,
		offered: vec!["a1: retry true, rephrase true".to_owned()],
	};
	let mut broke = Vec::new();
	for (queue, pending) in one_in_each_queue() {
		for sent_with_transcript in [true, false] {
			let arrival = if sent_with_transcript {
				"with the transcript"
			} else {
				"after it"
			};
			let mut events = waiting_turn();
			if sent_with_transcript {
				events.push(waiting_on(pending.clone()));
			}
			let mut thread = thread(cx, events);
			if !sent_with_transcript {
				let before = seen(&mut thread);
				if before != finished {
					broke.push(format!("before a {queue} arrived: {before:?}"));
				}
				thread.apply(vec![waiting_on(pending.clone())]);
			}
			let waiting = seen(&mut thread);
			if waiting != running {
				broke.push(format!("waiting on a {queue} sent {arrival}: {waiting:?}"));
			}
			thread.apply(vec![waiting_on(PendingDecisions::new())]);
			let withdrawn = seen(&mut thread);
			if withdrawn != finished {
				broke.push(format!("with the {queue} sent {arrival} withdrawn: {withdrawn:?}"));
			}
		}
	}
	assert_eq!(
		broke,
		Vec::<String>::new(),
		"a turn waiting on a decision is drawn finished, or stays running once it leaves"
	);
}
