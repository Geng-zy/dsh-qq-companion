/**
 * Local-time helpers shared by the companion modules.
 * @module dsh-qq-companion/companion/time
 */
/** Log callback shape used across the companion modules. */
export type Log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
/** Local hour at which a new "day" begins for session-age counting. */
export declare const DAY_BOUNDARY_HOUR = 4;
/** Local calendar day key (YYYY-MM-DD) of a timestamp. */
export declare const dayKey: (t: number) => string;
/** Index of the local day a timestamp belongs to, days starting at DAY_BOUNDARY_HOUR. */
export declare function boundaryDay(t: number): number;
/** Minutes since local midnight of an HH:MM string. */
export declare const toMinutes: (hhmm: string) => number;
/** Minutes since local midnight of a timestamp. */
export declare const minutesOfDay: (t: number) => number;
/** HH:MM of a timestamp, or of minutes-of-day. */
export declare const hhmm: (minutes: number) => string;
