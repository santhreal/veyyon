/**
 * The shape a domain publishes for a message role it adds to the transcript.
 *
 * A tool domain can put a message into the session that no provider defines — the shell domain
 * records a `!` command and a `$` Python run as their own roles — and the kernel's conversion of a
 * transcript into a provider request has to turn that role into something a model reads. The
 * domain owns the wording, the kernel owns the loop, so the domain states the conversion here and
 * the kernel looks it up by role.
 *
 * WHY A VALUE ON THE MANIFEST RATHER THAN A CASE IN THE KERNEL. The conversion of a `!` command
 * appends the exit-code notice and the output-spill notice, which are the shell domain's wording;
 * a case for it in the kernel imports the shell domain, and the kernel gate that derives its
 * subject from the tool registry fails on that import. A kind is data the manifest carries, so the
 * kernel reads it without naming the domain.
 *
 * Both members take the message the role names and nothing else: a kind is a pure function of the
 * message, which is what lets the kernel memoise a conversion by message identity.
 */
import type { Message } from "@veyyon/ai";
import type { AgentMessage } from "@veyyon/session";

export interface AgentMessageKind<TMessage extends AgentMessage = AgentMessage> {
	/** The role this kind converts, which is also the key the kernel looks it up under. */
	readonly role: TMessage["role"];
	/**
	 * The provider-facing messages this one becomes. An empty array is a message the model must not
	 * see, which is how a domain excludes a record from context without the kernel testing a flag
	 * it does not own.
	 */
	toLlm(message: TMessage): Message[];
	/** The message as one block of text, for a transcript dump. */
	toText(message: TMessage): string;
}
