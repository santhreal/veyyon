//! Dependency-free values for producer-owned and unknown payloads.

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Value {
	Null,
	Bool(bool),
	Number(String),
	String(String),
	Array(Vec<Value>),
	Object(Vec<(String, Value)>),
	Opaque { media_type: String, bytes: Vec<u8> },
}

impl Value {
	pub fn object_field(&self, name: &str) -> Option<&Value> {
		match self {
			Self::Object(fields) => fields
				.iter()
				.find_map(|(key, value)| (key == name).then_some(value)),
			_ => None,
		}
	}
}
