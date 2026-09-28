//! A tool result reaches the call it answers by the call's id, whatever
//! order the results arrive in, and counts the lines it holds past its
//! pane's ceiling whether it is drawn on its own or in its call's row.
//!
//! WHY: calls run side by side and their results come back in the order the
//! calls finished, so a result matched by its place in the turn draws one
//! call's output and failure under another call's row. The sweep sends the
//! results of three calls in every order and pins each row the reply plans
//! to the rows it plans when the results arrive in call order, where only
//! the first call failed, so a result read under the wrong call changes a
//! row's status. A pane cut at its ceiling with no count of the rest reads
//! as the whole output, so the count is pinned on both paths a result is
//! drawn by.
//!
//! Gap: the words an opened row paints are `turns`, and here a row's lines
//! are read from the plan; the arguments a call is titled by are the view
//! model's.

use std::collections::HashMap;

use gpui::TestAppContext;
use veyyon_desktop_app::transcript::{
	plan::{Piece, ToolBody},
	values::PANE_LINE_CEILING,
};
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

#[gpui::test]
fn a_result_read_in_its_calls_opened_row_counts_the_lines_past_its_ceiling(
	cx: &mut TestAppContext,
) {
	let mut thread = thread(cx, opened(Vec::new()));
	let open = HashMap::from([("c1".to_owned(), true)]);
	let mut broke = Vec::new();
	for (revision, (printed, rest)) in (2..).zip([
		(PANE_LINE_CEILING, None),
		(PANE_LINE_CEILING + 1, Some("… 1 more line")),
		(PANE_LINE_CEILING + 7, Some("… 7 more lines")),
	]) {
		let output = (0..printed)
			.map(|n| format!("row {n}"))
			.collect::<Vec<_>>()
			.join("\n");
		let ids = ["u", "a", "t"].map(|id| format!("{id}{revision}"));
		thread.apply(vec![snapshot(
			revision,
			chain(vec![
				(ids[0].as_str(), MessageRole::User, vec![text("read it")]),
				(ids[1].as_str(), MessageRole::Assistant, vec![call("c1", "src/a.rs")]),
				(ids[2].as_str(), MessageRole::ToolResult, vec![result("c1", &output, false)]),
			]),
		)]);
		let expected: Vec<String> = (0..printed.min(PANE_LINE_CEILING))
			.map(|n| format!("row {n}"))
			.chain(rest.map(str::to_owned))
			.collect();
		let bodies: Vec<Option<ToolBody>> = thread
			.plan_with(1, &open)
			.pieces
			.into_iter()
			.filter_map(|piece| match piece {
				Piece::Tool(row) => Some(row.body),
				_ => None,
			})
			.collect();
		let lines = match bodies.as_slice() {
			[Some(ToolBody::Lines(lines))] => lines,
			bodies => {
				broke.push(format!("{printed} lines planned the row bodies {bodies:?}"));
				continue;
			},
		};
		if *lines != expected {
			broke.push(format!(
				"{printed} lines planned a row of {} lines ending {:?}",
				lines.len(),
				lines.last()
			));
		}
	}
	assert_eq!(broke, Vec::<String>::new(), "an opened row lost the count of lines past it");
}
