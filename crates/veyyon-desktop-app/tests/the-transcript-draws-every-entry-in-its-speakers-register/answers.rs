//! A tool result reaches the call it answers by the call's id, whatever
//! order the results arrive in, and a result drawn on its own counts the
//! lines it holds past its pane's ceiling.
//!
//! WHY: calls run side by side and their results come back in the order the
//! calls finished, so a result matched by its place in the turn draws one
//! call's output and failure under another call's row. The sweep sends the
//! results of three calls in every order and pins each row the reply plans
//! to the rows it plans when the results arrive in call order, where only
//! the first call failed, so a result read under the wrong call changes a
//! row's status.
//!
//! Gap: the output drawn inside an opened row is `turns`; the arguments a
//! call is titled by are the view model's.

use gpui::TestAppContext;
use veyyon_desktop_app::transcript::values::PANE_LINE_CEILING;
use veyyon_desktop_model::{ContentBlock, MessageRole};

use super::{chain, entry, items::forms, opened, snapshot, text, thread};

/// A call to read `path`, identified by `id`.
fn call(id: &str, path: &str) -> ContentBlock {
	ContentBlock::ToolCall {
		id:           id.to_owned(),
		name:         "read".to_owned(),
		arguments:    serde_json::json!({ "path": path }),
		presentation: None,
	}
}

/// The result of call `id`.
fn result(id: &str, words: &str, is_error: bool) -> ContentBlock {
	ContentBlock::ToolResult {
		tool: id.to_owned(),
		content: serde_json::json!(words),
		is_error,
		presentation: None,
	}
}

/// The forms the reply plans when the results of its three calls arrive in
/// `order`.
fn planned_with(cx: &mut TestAppContext, order: [usize; 3]) -> Vec<String> {
	let results = [
		("t1", result("c1", "a.rs could not be read", true)),
		("t2", result("c2", "b.rs held two lines", false)),
		("t3", result("c3", "c.rs held one line", false)),
	];
	let mut entries = vec![
		("u1", MessageRole::User, vec![text("read three files")]),
		("a1", MessageRole::Assistant, vec![
			call("c1", "src/a.rs"),
			call("c2", "src/b.rs"),
			call("c3", "src/c.rs"),
		]),
	];
	for at in order {
		let (id, block) = results[at].clone();
		entries.push((id, MessageRole::ToolResult, vec![block]));
	}
	entries.push(("a2", MessageRole::Assistant, vec![text("done")]));
	let mut thread = thread(cx, opened(chain(entries)));
	forms(&mut thread, 1)
}

#[gpui::test]
fn every_result_reaches_the_call_it_answers_in_whatever_order_it_arrives(cx: &mut TestAppContext) {
	let in_order = planned_with(cx, [0, 1, 2]);
	let status = |forms: &[String], call: &str| {
		forms
			.iter()
			.find(|form| form.starts_with(&format!("tool {call} ")))
			.map(|form| form.split(':').next().unwrap_or_default().to_owned())
	};
	assert!(
		status(&in_order, "c1").is_some()
			&& status(&in_order, "c1").map(|s| s.replace("c1", ""))
				!= status(&in_order, "c2").map(|s| s.replace("c2", "")),
		"the failed call and the read one plan the same status, so a swap cannot show: {in_order:?}"
	);
	let mut broke = Vec::new();
	for order in [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
		let planned = planned_with(cx, order);
		if planned != in_order {
			broke.push(format!("results in order {order:?} planned {planned:?}"));
		}
	}
	assert_eq!(
		broke,
		Vec::<String>::new(),
		"a result was read under a call it does not answer; in call order the reply plans \
		 {in_order:?}"
	);
}

#[gpui::test]
fn a_result_drawn_on_its_own_counts_the_lines_past_its_ceiling(cx: &mut TestAppContext) {
	let mut thread = thread(cx, opened(Vec::new()));
	let mut broke = Vec::new();
	for (revision, (printed, rest)) in (2..).zip([
		(PANE_LINE_CEILING, None),
		(PANE_LINE_CEILING + 1, Some("… 1 more line")),
		(PANE_LINE_CEILING + 7, Some("… 7 more lines")),
	]) {
		let id = format!("r{revision}");
		let output = (0..printed)
			.map(|n| format!("row {n}"))
			.collect::<Vec<_>>()
			.join("\n");
		thread.apply(vec![snapshot(revision, vec![entry(
			&id,
			None,
			MessageRole::ToolResult,
			vec![result("unmatched", &output, false)],
		)])]);
		let tail: Vec<String> = (PANE_LINE_CEILING - 1..PANE_LINE_CEILING)
			.map(|n| format!("row {n}"))
			.chain(rest.map(str::to_owned))
			.collect();
		let planned = forms(&mut thread, 0);
		let ends = planned
			.first()
			.is_some_and(|form| form.ends_with(&tail.join(" | ")));
		if planned.len() != 1 || !ends {
			let last = planned.first().and_then(|form| form.rsplit(" | ").next());
			broke.push(format!("{printed} lines planned a pane ending {last:?}"));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "a result's pane lost the count of lines past it");
}
