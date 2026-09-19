//! Sweep plumbing for the dead-token suite: enumerating the measures from the
//! loaded token value, doubling one at a time, and reducing a render to
//! something two runs can be compared by.
//!
//! The probe surfaces themselves are in `views`, so this file stays about the
//! sweep and that one about what is drawn.

#![expect(dead_code, reason = "each integration test target uses a subset of these helpers")]

use std::hash::{DefaultHasher, Hash, Hasher};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use veyyon_desktop_scene::{Headless, RgbaFrame, distinct_pixel_values};
use veyyon_desktop_tokens::Tokens;

pub mod views;

/// One thing the product produced from a token set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
	/// A rendered frame, reduced to a hash of its pixels and the count of
	/// distinct values it holds.
	Frame { name: &'static str, pixels: u64, distinct_values: usize },
	/// A geometry the product reports rather than draws, such as the box an
	/// input method is placed against.
	Report { name: &'static str, text: String },
}

/// Everything one token set produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed(Vec<Observation>);

impl Observed {
	pub fn frames(&self) -> &[Observation] {
		&self.0
	}
}

/// Reduces a frame to a value two runs compare by.
pub fn frame_observation(name: &'static str, frame: &RgbaFrame) -> Observation {
	let mut hasher = DefaultHasher::new();
	frame.as_bytes().hash(&mut hasher);
	Observation::Frame {
		name,
		pixels: hasher.finish(),
		distinct_values: distinct_pixel_values(frame),
	}
}

/// Every numeric leaf of `value`, as a dotted path under `prefix`.
///
/// The paths come from serde rather than from a list written here, so a field
/// added to one of these structs enters the sweep without an edit.
pub fn number_keys<T: Serialize>(prefix: &str, value: &T) -> Vec<String> {
	let json = serde_json::to_value(value).expect("a token struct must serialize");
	let mut keys = Vec::new();
	collect_numbers(&json, prefix, &mut keys);
	keys
}

fn collect_numbers(value: &Value, path: &str, out: &mut Vec<String>) {
	match value {
		Value::Number(_) => out.push(path.to_owned()),
		Value::Object(map) => {
			for (key, child) in map {
				collect_numbers(child, &format!("{path}.{key}"), out);
			}
		},
		_ => {},
	}
}

/// `tokens` with the one measure at `key` doubled and offset, which is a value
/// no clamp and no rounding maps back onto the authored one.
pub fn mutate_number(tokens: &Tokens, key: &str) -> Tokens {
	let mut mutated = tokens.clone();
	let (group, rest) = key.split_once('.').expect("a swept key names its group");
	match group {
		"controls" => mutated.controls = replace(&tokens.controls, rest),
		"elevation" => match rest.split_once('.') {
			Some(("float_shadow", field)) => {
				mutated.elevation.float_shadow = replace(&tokens.elevation.float_shadow, field);
			},
			_ => mutated.elevation.overlay_blur_px = bump(tokens.elevation.overlay_blur_px),
		},
		"surface" => {
			let field = rest
				.strip_prefix("transcript.")
				.expect("only transcript is swept");
			mutated.surface.transcript = replace(&tokens.surface.transcript, field);
		},
		other => panic!("the sweep has no mutation for group {other}"),
	}
	mutated
}

const fn bump(value: f32) -> f32 {
	value.mul_add(2.0, 3.0)
}

/// `value` with the numeric field at the dotted `path` bumped, through serde so
/// no field is named twice in this file.
fn replace<T: Serialize + DeserializeOwned>(value: &T, path: &str) -> T {
	let mut json = serde_json::to_value(value).expect("a token struct must serialize");
	let mut cursor = &mut json;
	let mut parts = path.split('.').peekable();
	while let Some(part) = parts.next() {
		let object = cursor
			.as_object_mut()
			.unwrap_or_else(|| panic!("{path} does not name a table"));
		let child = object
			.get_mut(part)
			.unwrap_or_else(|| panic!("{path} does not name a field"));
		if parts.peek().is_none() {
			let current = child
				.as_f64()
				.unwrap_or_else(|| panic!("{path} is not a number"));
			#[expect(clippy::cast_possible_truncation, reason = "a measure is authored as f32")]
			let bumped = f64::from(bump(current as f32));
			*child = serde_json::json!(bumped);
			break;
		}
		cursor = child;
	}
	serde_json::from_value(json).expect("a bumped token struct must deserialize")
}

/// Renders every probe surface against `tokens`.
pub fn observe(cx: &mut Headless, tokens: &Tokens) -> Observed {
	Observed(views::render_all(cx, tokens))
}
