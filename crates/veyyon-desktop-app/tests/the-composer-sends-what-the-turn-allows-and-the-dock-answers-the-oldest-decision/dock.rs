//! The dock: the oldest decision shown, the next shown as soon as one is
//! answered, a refused answer put back, and the composer answering what
//! takes a draft while a stray Enter answers nothing.

use gpui::TestAppContext;
use serde_json::{Value, json};
use veyyon_desktop_app::actions::{
	composer::Submit,
	dock::{ChatInstead, Pick1, Pick2},
};
use veyyon_desktop_model::{
	ApprovalInteraction, DialogInteraction, DialogOption, DialogQuestion, HostAction,
	PendingDecisions, PlanInteraction, QuestionInteraction,
};

use super::{refused, sid, waiting, window};

fn approval(id: &str, tool: &str, at: u64) -> ApprovalInteraction {
	ApprovalInteraction {
		id:              id.into(),
		tool_name:       tool.to_owned(),
		detail:          "rm -rf build".to_owned(),
		requested_at_ms: at,
	}
}

fn question(id: &str, prompt: &str, options: &[&str], at: u64) -> QuestionInteraction {
	QuestionInteraction {
		id:              id.into(),
		prompt:          prompt.to_owned(),
		options:         options.iter().map(|option| (*option).to_owned()).collect(),
		requested_at_ms: at,
	}
}

fn plan(id: &str, at: u64) -> PlanInteraction {
	PlanInteraction {
		id:              id.into(),
		markdown_plan:   "Move the parser behind a trait.".to_owned(),
		requested_at_ms: at,
	}
}

fn dialog(id: &str, at: u64) -> DialogInteraction {
	let option = |label: &str| DialogOption {
		label:       label.to_owned(),
		description: None,
		preview:     None,
	};
	DialogInteraction {
		id:              id.into(),
		questions:       vec![DialogQuestion {
			id:          "scope".to_owned(),
			question:    "Which crates move?".to_owned(),
			header:      Some("Scope".to_owned()),
			options:     vec![option("The parser"), option("Every crate")],
			multi:       false,
			recommended: Some(0),
			preselected: Vec::new(),
		}],
		requested_at_ms: at,
		expires_at_ms:   None,
	}
}

const fn only(
	approvals: Vec<ApprovalInteraction>,
	questions: Vec<QuestionInteraction>,
	plans: Vec<PlanInteraction>,
	dialogs: Vec<DialogInteraction>,
) -> PendingDecisions {
	PendingDecisions { approvals, questions, plans, dialogs }
}

fn respond(id: &str, response: Value) -> HostAction {
	HostAction::RespondToInteraction { session: sid(), interaction_id: id.to_owned(), response }
}

#[gpui::test]
fn an_answer_shows_the_next_decision_before_the_host_confirms_the_first(app: &mut TestAppContext) {
	let pending = only(
		vec![approval("a1", "bash", 1)],
		vec![question("q1", "Which branch?", &["main", "dev"], 2)],
		Vec::new(),
		Vec::new(),
	);
	let mut w = window(app, vec![waiting(pending)]);
	assert!(w.drew("Run bash?"), "the oldest decision shows first");
	assert!(w.drew("1 more waiting"));
	assert!(!w.drew("Which branch?"));

	w.dispatch(Pick1);
	assert_eq!(w.sent(), vec![respond("a1", json!({ "approved": true, "scope": "once" }))]);
	assert!(w.drew("Which branch?"), "the next decision shows before the host answers");
	assert!(!w.drew("Run bash?"));

	w.dispatch(Pick2);
	assert_eq!(w.sent(), vec![respond("q1", json!({ "option": 1, "text": "dev" }))]);
	assert!(!w.drew("Which branch?"), "the dock empties once every decision is answered");
}

#[gpui::test]
fn an_answer_the_host_refuses_puts_the_decision_back_marked(app: &mut TestAppContext) {
	let pending = only(vec![approval("a1", "bash", 1)], Vec::new(), Vec::new(), Vec::new());
	let mut w = window(app, vec![waiting(pending)]);
	w.dispatch(Pick1);
	let request = w
		.requests()
		.first()
		.map(|request| request.id)
		.expect("the answer was sent");
	assert!(!w.drew("Run bash?"));

	w.apply(vec![refused(request)]);
	assert!(w.drew("Run bash?"), "the refused decision is shown again");
	assert!(w.drew("The host did not take this answer. Answer it again."));
}

#[gpui::test]
fn a_stray_enter_answers_no_approval_and_the_draft_answers_a_question_or_refines_a_plan(
	app: &mut TestAppContext,
) {
	let pending = only(
		vec![approval("a1", "bash", 1)],
		vec![question("q1", "What should the branch be called?", &[], 2)],
		vec![plan("p1", 3)],
		Vec::new(),
	);
	let mut w = window(app, vec![waiting(pending)]);
	w.write("yes");
	w.dispatch(Submit);
	assert_eq!(w.sent(), Vec::new(), "Enter never approves a call");
	assert_eq!(w.draft(), "yes");

	w.dispatch(Pick1);
	assert_eq!(w.sent(), vec![respond("a1", json!({ "approved": true, "scope": "once" }))]);
	w.write("parser-trait");
	w.dispatch(Submit);
	assert_eq!(w.sent(), vec![respond("q1", json!({ "text": "parser-trait" }))]);
	assert_eq!(w.draft(), "", "the answer leaves the draft");

	w.dispatch(Submit);
	assert_eq!(w.sent(), Vec::new(), "an empty draft accepts no plan");
	w.write("Keep the old parser behind a flag.");
	w.dispatch(Submit);
	assert_eq!(w.sent(), vec![respond(
		"p1",
		json!({ "accepted": false, "feedback": "Keep the old parser behind a flag." }),
	)]);
}

#[gpui::test]
fn a_plan_is_accepted_by_its_first_choice_and_a_dialog_is_discussed_instead(
	app: &mut TestAppContext,
) {
	let pending = only(Vec::new(), Vec::new(), vec![plan("p1", 1)], vec![dialog("d1", 2)]);
	let mut w = window(app, vec![waiting(pending)]);
	assert!(w.drew("Accept"));
	w.dispatch(Pick1);
	assert_eq!(w.sent(), vec![respond("p1", json!({ "accepted": true, "feedback": "" }))]);

	assert!(w.drew("Which crates move?"), "the dialog shows once the plan is answered");
	w.dispatch(ChatInstead);
	assert_eq!(w.sent(), vec![respond("d1", json!({ "kind": "chat" }))]);
	assert!(!w.drew("Which crates move?"));
}
