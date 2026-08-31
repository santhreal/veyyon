//! Wire fallback markers are intentionally invisible.
//!
//! The canonical entry retains `producer` and `value`; this renderer suppresses
//! only presentation, matching the wire contract without discarding data.

use gpui::AnyElement;
use veyyon_gui_core::model::Value;

pub fn suppressed(_producer: &str, _value: &Value) -> Option<AnyElement> {
	None
}
