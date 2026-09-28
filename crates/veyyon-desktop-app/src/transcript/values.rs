//! The words a transcript row states about a value the host recorded.
//!
//! The target a tool call names, the lines a result or a run printed,
//! terminal output with its control sequences removed, a role's label, a
//! mode, a byte count.

use serde_json::Value;
use veyyon_desktop_model::{MessageRole, TranscriptEntry};

/// The most lines an output pane draws before it states how many it held back.
pub const PANE_LINE_CEILING: usize = 200;

/// Argument names a tool call states its target under, most specific first.
const TARGET_KEYS: &[&str] = &[
	"path",
	"file_path",
	"filePath",
	"file",
	"command",
	"cmd",
	"pattern",
	"query",
	"url",
	"uri",
	"name",
	"description",
];

/// The target a tool call names: the first argument a reader recognises as
/// what the call acts on, on one line.
#[must_use]
pub fn target_of(arguments: &Value) -> Option<String> {
	let object = arguments.as_object()?;
	TARGET_KEYS.iter().find_map(|key| {
		let value = object.get(*key)?;
		let text = match value {
			Value::String(text) => text.clone(),
			Value::Array(items) => items
				.iter()
				.filter_map(Value::as_str)
				.collect::<Vec<_>>()
				.join(" "),
			Value::Number(number) => number.to_string(),
			_ => return None,
		};
		let line = first_line(&sanitize(&text));
		(!line.is_empty()).then_some(line)
	})
}

/// The verb a tool row reads for a tool name: `read` reads `Read`,
/// `web_search` reads `Web search`.
#[must_use]
pub fn verb_of(tool: &str) -> String {
	let spaced = tool.replace(['_', '-'], " ");
	let mut chars = spaced.chars();
	match chars.next() {
		Some(first) => first.to_uppercase().chain(chars).collect(),
		None => String::new(),
	}
}

/// The lines a tool result states, read out of the content the host recorded.
///
/// A string is its own text; a list of content parts contributes each part's
/// `text`; anything else is stated as its JSON. An error with no text still
/// reads as an error.
#[must_use]
pub fn result_lines(content: &Value, is_error: bool) -> Vec<String> {
	let text = match content {
		Value::String(text) => text.clone(),
		Value::Array(parts) => parts
			.iter()
			.filter_map(|part| match part {
				Value::String(text) => Some(text.clone()),
				Value::Object(object) => object
					.get("text")
					.and_then(Value::as_str)
					.map(str::to_owned),
				_ => None,
			})
			.collect::<Vec<_>>()
			.join("\n"),
		Value::Null => String::new(),
		other => other.to_string(),
	};
	let mut lines = pane_lines(&text);
	if lines.is_empty() && is_error {
		lines.push("error".to_owned());
	}
	lines
}

/// Terminal output as the lines a pane draws: control sequences removed,
/// trailing blank lines dropped, and at most [`PANE_LINE_CEILING`] lines
/// followed by one stating how many more there were.
#[must_use]
pub fn pane_lines(output: &str) -> Vec<String> {
	let clean = sanitize(output);
	let mut lines: Vec<&str> = clean.lines().collect();
	while lines.last().is_some_and(|line| line.trim().is_empty()) {
		lines.pop();
	}
	let total = lines.len();
	let mut out: Vec<String> = lines
		.into_iter()
		.take(PANE_LINE_CEILING)
		.map(str::to_owned)
		.collect();
	match total.saturating_sub(PANE_LINE_CEILING) {
		0 => {},
		1 => out.push("… 1 more line".to_owned()),
		rest => out.push(format!("… {rest} more lines")),
	}
	out
}

fn first_line(text: &str) -> String {
	text
		.lines()
		.map(str::trim)
		.find(|line| !line.is_empty())
		.unwrap_or_default()
		.to_owned()
}

/// `text` with every ECMA-48 control sequence removed.
///
/// That covers CSI (`ESC [` or `0x9B` up to a final byte), OSC, DCS, SOS, PM
/// and APC strings (up to `BEL` or `ESC \`), two-byte escapes, and every
/// C0/C1 control except newline and tab. A tab becomes four spaces and a
/// carriage return that does not end a line starts the line over, as a
/// terminal draws it.
#[must_use]
pub fn sanitize(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut line_start = 0;
	let mut chars = text.chars().peekable();
	while let Some(ch) = chars.next() {
		match ch {
			'\u{1b}' => match chars.next() {
				Some('[') => skip_csi(&mut chars),
				Some(']' | 'P' | 'X' | '^' | '_') => skip_string(&mut chars),
				_ => {},
			},
			'\u{9b}' => skip_csi(&mut chars),
			'\u{90}' | '\u{98}' | '\u{9d}' | '\u{9e}' | '\u{9f}' => skip_string(&mut chars),
			'\n' => {
				out.push('\n');
				line_start = out.len();
			},
			'\r' => {
				if chars.peek() != Some(&'\n') {
					out.truncate(line_start);
				}
			},
			'\t' => out.push_str("    "),
			ch if ch.is_control() => {},
			ch => out.push(ch),
		}
	}
	out
}

fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
	for ch in chars.by_ref() {
		if ('\u{40}'..='\u{7e}').contains(&ch) {
			break;
		}
	}
}

fn skip_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
	while let Some(ch) = chars.next() {
		match ch {
			'\u{7}' | '\u{9c}' => break,
			'\u{1b}' if chars.peek() == Some(&'\\') => {
				chars.next();
				break;
			},
			_ => {},
		}
	}
}

/// The label a non-conversation role reads under, `None` for the operator
/// and the agent.
#[must_use]
pub(super) fn role_label(entry: &TranscriptEntry) -> Option<&'static str> {
	match entry.role {
		MessageRole::User | MessageRole::Assistant => None,
		MessageRole::Developer => Some("Developer"),
		MessageRole::Custom => Some(match entry.raw_discriminator.as_str() {
			"side_question" => "Side question",
			"side_answer" => "Side answer",
			_ => "Custom",
		}),
		MessageRole::ToolResult => Some("Tool result"),
		MessageRole::BashExecution => Some("Shell execution"),
		MessageRole::PythonExecution => Some("Python execution"),
		MessageRole::BranchSummary => Some("Branch summary"),
		MessageRole::CompactionSummary => Some("Compaction summary"),
		MessageRole::FileMention => Some("File"),
		MessageRole::Lifecycle => Some("Lifecycle"),
		MessageRole::Unknown => Some("Unknown"),
	}
}

/// The words a recorded mode reads as: `none` is `off`, separators open out.
#[must_use]
pub fn mode_words(mode: &str) -> String {
	match mode {
		"none" => "off".to_owned(),
		other => other.replace(['_', '-'], " "),
	}
}

pub(super) fn video_words(media_type: &str, bytes: u64) -> String {
	format!("[video {media_type}, {}]", human_bytes(bytes))
}

/// `512 B`, `12.3 KB`, `4.0 MB`.
#[must_use]
pub fn human_bytes(bytes: u64) -> String {
	const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
	if bytes < 1024 {
		return format!("{bytes} B");
	}
	let mut value = bytes;
	let mut unit = UNITS.iter();
	let mut name = unit.next().copied().unwrap_or("KB");
	while value >= 1024 * 1024 {
		let Some(next) = unit.next() else { break };
		value /= 1024;
		name = next;
	}
	let tenths = value * 10 / 1024;
	format!("{}.{} {name}", tenths / 10, tenths % 10)
}
