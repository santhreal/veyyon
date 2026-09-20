//! What a recorded value reads as: the caption of a call, the text of a
//! result, the lines of a pane.
//!
//! A transcript records a tool's arguments and its output as JSON, and every
//! surface that draws either reads it the same way. Held apart from the turns
//! it is read for, because a second reader of the same value is a second rule
//! about what a result says.

use serde_json::Value;

/// How many lines a mono pane keeps before the rest is counted, not shown.
///
/// A command's output can run to the tens of thousands of lines, and a
/// transcript that holds all of them draws none of them in time.
pub const PANE_LINE_CEILING: usize = 200;

/// The one argument a tool call is best summarised by.
pub(super) fn target_of(arguments: &Value) -> String {
	const KEYS: [&str; 8] =
		["path", "file_path", "command", "cmd", "pattern", "query", "url", "input"];
	let Some(object) = arguments.as_object() else {
		return value_text(arguments)
			.lines()
			.next()
			.unwrap_or_default()
			.to_string();
	};
	KEYS
		.iter()
		.find_map(|key| object.get(*key).and_then(Value::as_str))
		.or_else(|| object.values().find_map(Value::as_str))
		.unwrap_or_default()
		.to_string()
}

/// A recorded value as the text it stands for, not as its JSON spelling.
fn value_text(value: &Value) -> String {
	match value {
		Value::String(text) => text.clone(),
		Value::Null => String::new(),
		other => other.to_string(),
	}
}

/// A tool result's lines, with a failure stated on the first of them.
pub(super) fn result_lines(value: &Value, is_error: bool) -> Vec<String> {
	let mut lines = pane_lines(&value_text(value));
	if is_error {
		if let Some(first) = lines.first_mut() {
			first.insert_str(0, "error: ");
		} else {
			lines.push("error: ".to_string());
		}
	}
	lines
}

/// The lines of a pane, held to the ceiling with the remainder counted.
pub(super) fn pane_lines(text: &str) -> Vec<String> {
	let total = text.lines().count();
	let mut lines: Vec<String> = text
		.lines()
		.take(PANE_LINE_CEILING)
		.map(str::to_string)
		.collect();
	if total > PANE_LINE_CEILING {
		lines.push(format!("… {} more lines", total - PANE_LINE_CEILING));
	}
	lines
}
