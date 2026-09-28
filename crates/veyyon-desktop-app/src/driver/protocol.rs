//! The driver's JSON-lines protocol: one request per line, one reply per
//! request, frame events interleaved.

use gpui::{Bounds, Pixels};
use serde_json::Value;

/// A request a client sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Request {
	/// Dispatch the action registered as `name`, built from `args`.
	Dispatch { name: String, args: Option<Value> },
	/// Type `text` into the focused input.
	Type(String),
	/// Report the window bounds of a target.
	Bounds(String),
	/// Send an event for every painted frame.
	SubscribeFrames,
	/// Reply once `condition` holds.
	Wait(Condition),
}

/// What a `wait` request waits for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Condition {
	/// No frame is requested and nothing moves.
	Idle,
	/// The text painted inside `target` contains `contains`.
	Text { target: String, contains: String },
}

/// Parses one request line into its id and the request, or an error message
/// naming what is wrong with it. A line that is not a JSON object has the id
/// `null`.
pub(super) fn parse(line: &str) -> (Value, Result<Request, String>) {
	let object = match serde_json::from_str::<Value>(line) {
		Ok(Value::Object(object)) => object,
		Ok(_) => return (Value::Null, Err("a request is a JSON object".into())),
		Err(error) => return (Value::Null, Err(format!("the request is not JSON: {error}"))),
	};
	let id = object.get("id").cloned().unwrap_or(Value::Null);
	let request = if let Some(name) = object.get("dispatch") {
		name
			.as_str()
			.map(|name| Request::Dispatch { name: name.to_owned(), args: object.get("args").cloned() })
			.ok_or_else(|| "`dispatch` names an action as a string".to_owned())
	} else if let Some(text) = object.get("type") {
		text
			.as_str()
			.map(|text| Request::Type(text.to_owned()))
			.ok_or_else(|| "`type` holds the text to type as a string".to_owned())
	} else if let Some(target) = object.get("bounds") {
		target
			.as_str()
			.map(|target| Request::Bounds(target.to_owned()))
			.ok_or_else(|| "`bounds` names a target as a string".to_owned())
	} else if let Some(stream) = object.get("subscribe") {
		match stream.as_str() {
			Some("frames") => Ok(Request::SubscribeFrames),
			_ => Err("`subscribe` accepts \"frames\"".to_owned()),
		}
	} else if let Some(kind) = object.get("wait") {
		wait(kind.as_str(), &object).map(Request::Wait)
	} else {
		Err("a request holds one of `dispatch`, `type`, `bounds`, `subscribe`, `wait`".to_owned())
	};
	(id, request)
}

fn wait(kind: Option<&str>, object: &serde_json::Map<String, Value>) -> Result<Condition, String> {
	match kind {
		Some("idle") => Ok(Condition::Idle),
		Some("text") => {
			let field = |name: &str| {
				object
					.get(name)
					.and_then(Value::as_str)
					.map(str::to_owned)
					.ok_or_else(|| format!("`wait: \"text\"` holds `{name}` as a string"))
			};
			Ok(Condition::Text { target: field("target")?, contains: field("contains")? })
		},
		_ => Err("`wait` accepts \"idle\" or \"text\"".to_owned()),
	}
}

// Replies are written field by field, so their bytes are the same whether or
// not serde_json keeps the insertion order of an object's keys.

/// The reply to a request that succeeded with nothing to report.
pub(super) fn ok(id: &Value) -> String {
	format!("{{\"id\":{id},\"ok\":true}}")
}

/// The reply to a request that failed.
pub(super) fn error(id: &Value, message: &str) -> String {
	format!("{{\"id\":{id},\"error\":{}}}", Value::from(message))
}

/// The reply to a bounds request, in window pixels.
pub(super) fn bounds(id: &Value, bounds: Bounds<Pixels>) -> String {
	let number = |value: Pixels| Value::from(f32::from(value));
	format!(
		"{{\"id\":{id},\"bounds\":{{\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}}}",
		number(bounds.origin.x),
		number(bounds.origin.y),
		number(bounds.size.width),
		number(bounds.size.height),
	)
}

/// The event sent for painted frame `n` at `t_ns` on `CLOCK_MONOTONIC`.
pub(super) fn frame(n: u64, t_ns: u64) -> String {
	format!("{{\"event\":\"frame\",\"n\":{n},\"t_ns\":{t_ns}}}")
}
