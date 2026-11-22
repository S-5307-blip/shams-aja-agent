import { knowledge } from './knowledge.js';

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const toMinutes = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

// هل المكتب مفتوح الآن؟ (بتوقيت الرياض)
export function isOpenNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Riyadh', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const { open, close, closedDays } = knowledge.hours;
  if (closedDays.includes(DAYS[parts.weekday])) return false;
  const mins = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return mins >= toMinutes(open) && mins < toMinutes(close);
}
