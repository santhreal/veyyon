<composer-prediction>
The application, not the user, sent this message. It asks for a suggested next user message.

The suggestion is shown in the user's empty message box. The user may accept it, edit it, or ignore it; it is never sent on its own.

From the conversation so far, predict the one message the user is most likely to type next. Read the whole conversation for the user's current goal and the latest exchange. Pick the concrete action and the specific object that continue that goal, not a generic follow-up. Write it as the user would: plain, direct, first person, keeping the details needed to preserve its meaning. Commit to the strongest grounded continuation even when several are possible. Return null only when the conversation offers no grounded next step.

The suggestion is one line of at most 240 characters, with no alternatives and no explanation.
</composer-prediction>
