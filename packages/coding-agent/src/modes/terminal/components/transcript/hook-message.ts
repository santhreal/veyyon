import type { HookBlock } from "@veyyon/wire/presentation";
import { FramedMessageComponent } from "./message-frame";

/**
 * Component that renders a custom message entry from hooks.
 * Uses distinct styling to differentiate from user messages.
 */
export class HookMessageComponent extends FramedMessageComponent<HookBlock> {}
