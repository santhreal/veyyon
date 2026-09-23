//! Sweep plumbing for the dead-token suites: enumerating the measures from the
//! loaded token value, doubling one at a time, and reducing a render to
//! something two runs can be compared by.
//!
//! One suite sweeps one group of measures against the states that draw them,
//! because a palette measure is invisible until the palette is open and a
//! whole-window render per key is not free. `GROUPS` is the registry those
//! suites partition: every numeric measure belongs to exactly one group, and
//! `a-every-measure-belongs-to-a-suite-that-sweeps-it.rs` fails when one
//! belongs to none.

#![expect(dead_code, reason = "each integration test target uses a subset of these helpers")]

use std::hash::{DefaultHasher, Hash, Hasher};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use veyyon_desktop_scene::{Headless, RgbaFrame, distinct_pixel_values};
use veyyon_desktop_tokens::Tokens;

pub mod shell;
pub mod views;

/// Every group of measures a suite sweeps, as the key prefix it claims.
///
/// A key belongs to the group with the longest matching prefix, so a table
/// drawn by one surface is claimed by that surface's suite rather than by the
/// file it happens to be authored in.
pub const GROUPS: &[&str] = &[
	"controls",
	"elevation",
	"surface.transcript.tool_view_",
	"surface.transcript",
	"surface.queue",
	"surface.composer",
	"surface.attached_cards",
	"surface.panels",
	"surface.palette",
	"surface.settings",
	"surface.agents",
	"surface.share",
	"surface.breakpoints",
	"surface.shell",
	"motion",
];

/// What a suite renders a token set into.
pub type ObserveFn = fn(&mut Headless, &Tokens) -> Vec<Observation>;

/// Every numeric measure of `tokens`, as a dotted path.
pub fn all_keys(tokens: &Tokens) -> Vec<String> {
	let mut keys = number_keys("controls", &tokens.controls);
	keys.extend(number_keys("elevation", &tokens.elevation));
	keys.extend(number_keys("surface", &tokens.surface));
	keys.extend(number_keys("motion", &tokens.motion));
	keys
}

/// The group `key` belongs to: the longest registered prefix it starts with.
pub fn group_of(key: &str) -> Option<&'static str> {
	GROUPS
		.iter()
		.filter(|group| key.starts_with(*group))
		.max_by_key(|group| group.len())
		.copied()
}

/// Every measure `group` claims.
pub fn keys_in(group: &str, tokens: &Tokens) -> Vec<String> {
	all_keys(tokens)
		.into_iter()
		.filter(|key| group_of(key) == Some(group))
		.collect()
}

/// Doubles each measure `group` claims in turn and names the ones no state
/// `observe` renders reacted to.
///
/// The caller states the group rather than a key list, so a measure added to
/// the struct enters its suite with no edit to the suite.
pub fn sweep(group: &str, observe: ObserveFn, cx: &mut Headless, tokens: &Tokens) -> Vec<String> {
	let baseline = Observed(observe(cx, tokens));
	keys_in(group, tokens)
		.into_iter()
		.filter(|key| Observed(observe(cx, &mutate_number(tokens, key))) == baseline)
		.collect()
}

/// Fails naming every measure of `group` that nothing drew.
pub fn assert_every_measure_is_drawn(group: &str, observe: ObserveFn) {
	assert_every_measure_is_drawn_except(group, observe, &[]);
}

/// Fails naming every measure of `group` that nothing drew, except the ones
/// `covered` records as reaching the product where no raster can see them.
///
/// A measure the window manager reads rather than the renderer — a window
/// minimum handed to the platform before a frame exists — produces no pixel by
/// construction, so a row here names it and the suite that does prove it. The
/// comparison is exact in both directions: a newly dead measure fails, and a
/// recorded one that starts moving a pixel fails until its row is dropped.
pub fn assert_every_measure_is_drawn_except(
	group: &str,
	observe: ObserveFn,
	covered: &[(&str, &str)],
) {
	let shipped = veyyon_desktop_tokens::load_bundled_tokens().expect("the tokens must load");
	let claimed = keys_in(group, &shipped);
	assert!(!claimed.is_empty(), "{group} claims no measure, so its suite sweeps nothing");
	for (key, suite) in covered {
		assert!(
			claimed.iter().any(|claimed_key| claimed_key == key),
			"{key} is recorded as covered by {suite}, but {group} claims no such measure"
		);
	}

	let mut cx = veyyon_desktop_scene::headless_context().expect("a Vulkan ICD is required");
	let observed = Observed(observe(&mut cx, &shipped));
	// A blank or uniform observation compares equal to every other one, so a
	// sweep over it would pass while showing nothing.
	for observation in observed.frames() {
		match observation {
			Observation::Frame { name, distinct_values, .. } => assert!(
				*distinct_values > 1,
				"probe frame {name} drew one colour, so no mutation of it could be seen"
			),
			Observation::Report { name, text } => {
				assert!(!text.is_empty(), "probe report {name} is empty");
			},
		}
	}

	let mut dead = sweep(group, observe, &mut cx, &shipped);
	dead.sort();
	let mut recorded: Vec<String> = covered.iter().map(|(key, _)| (*key).to_owned()).collect();
	recorded.sort();
	assert_eq!(
		dead, recorded,
		"a measure that changed nothing the product produced reads nowhere, and one recorded as \
		 covered elsewhere that now moves a pixel is a row to drop: covered rows are {covered:?}"
	);
}

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
	/// Everything one run produced, in the order the probe produced it.
	///
	/// A sibling probe that varies something other than a token — the colour
	/// sweep varies the theme — compares runs the same way, so the wrapper is
	/// constructed here rather than copied there.
	#[must_use]
	pub const fn new(observations: Vec<Observation>) -> Self {
		Self(observations)
	}

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
		"elevation" => mutated.elevation = replace(&tokens.elevation, rest),
		"surface" => mutated.surface = replace(&tokens.surface, rest),
		"motion" => mutated.motion = replace(&tokens.motion, rest),
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
			// A count is authored as an integer and deserializes as one, so a
			// bumped count stays whole rather than arriving as a float the
			// struct rejects.
			*child = if child.is_f64() {
				serde_json::json!(bumped)
			} else {
				#[expect(
					clippy::cast_possible_truncation,
					clippy::cast_sign_loss,
					reason = "a bumped count is positive and far inside u64"
				)]
				let whole = bumped as u64;
				serde_json::json!(whole)
			};
			break;
		}
		cursor = child;
	}
	serde_json::from_value(json).expect("a bumped token struct must deserialize")
}
