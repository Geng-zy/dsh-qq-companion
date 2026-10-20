/**
 * /task: list the daily scheduled prompts and today's proactive plan, or run
 * one now (`/task checkin` wakes her for a check-in right away).
 * @module dsh-qq-companion/companion/task-command
 */
import type { ScheduledPrompt } from './scheduler.js';
export interface TaskCommandContext {
    scheduledPrompts?: () => readonly ScheduledPrompt[];
    proactive?: {
        remaining(): string[];
        fireNow(): Promise<void>;
    };
    fireScheduled?: (prompt: ScheduledPrompt) => Promise<void>;
}
export declare function handleTaskCommand(ctx: TaskCommandContext, arg: string, reply: (text: string) => Promise<unknown>): Promise<void>;
