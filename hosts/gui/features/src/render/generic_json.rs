//! Lossless generic rendering for producer-owned and unknown values.

use gpui::{App, Div, Styled, px};
use veyyon_gui_core::model::Value;

use super::code;

const MAX_RENDER_DEPTH: usize = 64;

/// Generic JSON-like detail. The source value stays in core even when no
/// producer-specific renderer is installed.
pub fn detail(id: &str, value: &Value, cx: &mut App) -> Div {
	code::well(id, "json", &format(value), cx)
		.w_full()
		.min_w(px(0.0))
		.overflow_hidden()
}

/// Stable, valid JSON text for every dependency-free value variant.
pub fn format(value: &Value) -> String {
	let mut output = String::new();
	write_value(value, 0, &mut output);
	output
}

fn write_value(value: &Value, depth: usize, output: &mut String) {
	if depth >= MAX_RENDER_DEPTH {
		output.push_str("\"<nested value retained>\"");
		return;
	}
	match value {
		Value::Null => output.push_str("null"),
		Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
		Value::Number(value) => output.push_str(value),
		Value::String(value) => write_string(value, output),
		Value::Opaque { media_type, bytes } => {
			output.push_str("{\n");
			indent(depth + 1, output);
			output.push_str("\"mediaType\": ");
			write_string(media_type, output);
			output.push_str(",\n");
			indent(depth + 1, output);
			output.push_str("\"bytes\": ");
			output.push_str(&bytes.len().to_string());
			output.push('\n');
			indent(depth, output);
			output.push('}');
		},
		Value::Array(values) => {
			output.push('[');
			for (index, value) in values.iter().enumerate() {
				if index > 0 {
					output.push(',');
				}
				output.push('\n');
				indent(depth + 1, output);
				write_value(value, depth + 1, output);
			}
			if !values.is_empty() {
				output.push('\n');
				indent(depth, output);
			}
			output.push(']');
		},
		Value::Object(fields) => {
			output.push('{');
			for (index, (key, value)) in fields.iter().enumerate() {
				if index > 0 {
					output.push(',');
				}
				output.push('\n');
				indent(depth + 1, output);
				write_string(key, output);
				output.push_str(": ");
				write_value(value, depth + 1, output);
			}
			if !fields.is_empty() {
				output.push('\n');
				indent(depth, output);
			}
			output.push('}');
		},
	}
}

fn indent(depth: usize, output: &mut String) {
	for _ in 0..depth {
		output.push_str("  ");
	}
}

fn write_string(value: &str, output: &mut String) {
	output.push('"');
	for character in value.chars() {
		match character {
			'"' => output.push_str("\\\""),
			'\\' => output.push_str("\\\\"),
			'\n' => output.push_str("\\n"),
			'\r' => output.push_str("\\r"),
			'\t' => output.push_str("\\t"),
			character if character.is_control() => {
				use std::fmt::Write;
				let _ = write!(output, "\\u{:04x}", u32::from(character));
			},
			character => output.push(character),
		}
	}
	output.push('"');
}
