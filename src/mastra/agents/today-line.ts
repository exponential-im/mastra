/**
 * The date line appended to agent instructions.
 *
 * It used to read "Today's date is 2026-11-18 (UTC)." with no weekday, and an
 * agent asked for "Monday, Wednesday and Friday" decided the 18th was a
 * Monday. It was a Wednesday. Weekdays are now stated, for today and the days
 * after it, so they are read and never computed.
 *
 * Date-only and UTC on purpose: the prompt-cache prefix then changes once per
 * UTC day. The person's local time and zone come from the chat surface.
 */
const DAY = 24 * 60 * 60 * 1000;

export function todayLine(now: Date = new Date()): string {
  const weekday = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(d);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const next = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() + (i + 1) * DAY))
    .map((d) => `${weekday(d).slice(0, 3)} ${iso(d)}`)
    .join(", ");
  return (
    `Today is ${weekday(now)}, ${iso(now)} (UTC). The next days: ${next}. ` +
    `Read weekdays from this line or from the user's local date when the conversation gives one; never work one out from memory. ` +
    `When you propose or confirm a date, state it with its weekday. ` +
    `When the conversation does not state the user's local time and zone, call get-my-time-zone before you work with a clock time; ` +
    `if it has no zone, ask the user once, never assume UTC.`
  );
}
