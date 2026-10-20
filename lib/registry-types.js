/** The mapping file name inside the media dir. */
export const MAPPING_FILE = 'chat-sessions.json';
/** build one mapping entry — a bare session id when the chat carries no
 * persisted settings (byte-identical to the legacy format), else an object
 * with the optional mode/goal/workspace fields. An empty workspacePath counts
 * as unset (never persisted). */
export function persistEntry(sessionId, interimOverride, goal, workspacePath) {
    const ws = workspacePath !== undefined && workspacePath !== '' ? workspacePath : undefined;
    if (interimOverride === undefined && goal === undefined && ws === undefined)
        return sessionId;
    const entry = { session: sessionId };
    if (interimOverride !== undefined)
        entry.interimOverride = interimOverride;
    if (goal !== undefined)
        entry.goal = goal;
    if (ws !== undefined)
        entry.workspacePath = ws;
    return entry;
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export function resolveRecordedPreset(inspection) {
    const events = inspection.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            return event.data.agentPreset;
        }
    }
    return inspection.meta.agentPreset;
}
