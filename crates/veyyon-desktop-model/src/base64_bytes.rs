//! Serde codec for a byte payload that crosses the wire as a base64 string.
//!
//! JSON has no byte type: serde's default for `Vec<u8>` is an array of
//! numbers, three to four characters per byte, which puts a 20 MiB clip at
//! 75 MB on the wire. Base64 is 4/3 of the payload, and it is the encoding the
//! host's model layer holds the payload in, so the host passes it through
//! without re-encoding.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Serialises `bytes` as a standard, padded base64 string.
pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
	STANDARD.encode(bytes).serialize(serializer)
}

/// Deserialises a standard base64 string, rejecting anything that is not one
/// with the decoder's own message.
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
	let text = String::deserialize(deserializer)?;
	STANDARD.decode(text).map_err(serde::de::Error::custom)
}
