/**
 * Guard against a model "continuing the transcript": every inbound message
 * reaches the model with a header such as `[09:56 昵称(QQ号)]` (and group
 * lines wrapped in <user_message>). A model that keeps generating past its
 * reply sometimes writes a fake next line in that format — inventing other
 * people's messages, recall notices, QQ numbers — often followed by its own
 * meta commentary. Anything from the first such line on is not her reply,
 * so it is cut before it reaches QQ.
 * @module dsh-qq-companion/companion/sanitize
 */
/**
 * @returns the reply up to (not including) the first fabricated context
 * line, with trailing separators trimmed; `cut` tells whether anything was
 * removed.
 */
export declare function cutFabricatedContext(text: string): {
    text: string;
    cut: boolean;
};
