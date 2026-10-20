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

/** A line imitating the plugin's own inbound header or message wrapper. */
const FABRICATED_CONTEXT = /^[ \t]*(?:\[受限用户[^\]\n]*\][ \t]*)?\[\d{1,2}:\d{2}[^\]\n]*\(\d{5,12}\)\]|<\/?user_message\b/m

/** Separator lines a model puts before the fake continuation. */
const TRAILING_SEPARATOR = /(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,}|={3,})?[ \t]*)+$/

/**
 * @returns the reply up to (not including) the first fabricated context
 * line, with trailing separators trimmed; `cut` tells whether anything was
 * removed.
 */
export function cutFabricatedContext(text: string): { text: string; cut: boolean } {
  const match = FABRICATED_CONTEXT.exec(text)
  if (match === null) return { text, cut: false }
  const kept = text.slice(0, match.index).replace(TRAILING_SEPARATOR, '').trimEnd()
  return { text: kept, cut: true }
}
