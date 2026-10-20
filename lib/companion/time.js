/**
 * Local-time helpers shared by the companion modules.
 * @module dsh-qq-companion/companion/time
 */
/** Local hour at which a new "day" begins for session-age counting. */
export const DAY_BOUNDARY_HOUR = 4;
/** Local calendar day key (YYYY-MM-DD) of a timestamp. */
export const dayKey = (t) => {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
/** Index of the local day a timestamp belongs to, days starting at DAY_BOUNDARY_HOUR. */
export function boundaryDay(t) {
    const d = new Date(t - DAY_BOUNDARY_HOUR * 3_600_000);
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);
}
/** Minutes since local midnight of an HH:MM string. */
export const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};
/** Minutes since local midnight of a timestamp. */
export const minutesOfDay = (t) => {
    const d = new Date(t);
    return d.getHours() * 60 + d.getMinutes();
};
/** HH:MM of a timestamp, or of minutes-of-day. */
export const hhmm = (minutes) => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
