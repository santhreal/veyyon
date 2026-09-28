//! The words a transcript row states about a value the host recorded: the
//! target a tool call names, the lines a result or a run printed, and terminal
//! output with its control sequences removed.

use serde_json::Value;

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
			Value::Array(items) => {
				items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")
			},
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
				Value::Object(object) => object.get("text").and_then(Value::as_str).map(str::to_owned),
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
	let mut out: Vec<String> =
		lines.into_iter().take(PANE_LINE_CEILING).map(str::to_owned).collect();
	if total > PANE_LINE_CEILING {
		out.push(format!("… {} more lines", total - PANE_LINE_CEILING));
	}
	out
}

fn first_line(text: &str) -> String {
	text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().to_owned()
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
