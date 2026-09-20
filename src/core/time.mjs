export const FPS_RATES = {
  23.976: [24000, 1001],
  '23.98': [24000, 1001],
  24: [24, 1],
  25: [25, 1],
  29.97: [30000, 1001],
  30: [30, 1]
};

export function normalizeFps(value) {
  if (value === null || value === undefined || value === '') return 24;
  const key = String(value).trim().toLowerCase();
  if (key === '23.976' || key === '23.98') return 23.976;
  const numeric = Number(key);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Unsupported fps: ${String(value)}`);
  }
  if (Math.abs(numeric - 23.976) < 0.001) return 23.976;
  return numeric;
}

export function fpsRate(fps) {
  const normalized = normalizeFps(fps);
  return FPS_RATES[normalized] ?? [normalized, 1];
}

export function frameToMs(frame, fps) {
  if (!Number.isInteger(frame)) throw new Error('Frame number must be an integer');
  const [numerator, denominator] = fpsRate(fps);
  return Math.round((frame * denominator * 1000) / numerator);
}

export function msToFrame(ms, fps) {
  const [numerator, denominator] = fpsRate(fps);
  return Math.round((ms * numerator) / (denominator * 1000));
}

export function parseClockToMs(value) {
  const text = String(value).trim().replace(',', '.');
  const match = text.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.](\d+))?$/);
  if (!match) return null;
  const hoursPart = Number(match[1] ?? 0);
  const minutesPart = Number(match[2] ?? (match[1] === undefined ? 0 : match[1]));
  const secondsPart = Number(match[3]);
  const fractionText = (match[4] ?? '').padEnd(3, '0');
  const wholeMilliseconds = Number(fractionText.slice(0, 3));
  const subMillisecondDigits = (match[4] ?? '').slice(3);
  const subMillisecondNs = Number((subMillisecondDigits + '000000').slice(0, 6));
  const roundedMilliseconds = wholeMilliseconds + (subMillisecondNs >= 500000 ? 1 : 0);
  if (match[2] === undefined && match[1] !== undefined && minutesPart > 59) return null;
  return ((hoursPart * 60 + minutesPart) * 60 + secondsPart) * 1000 + roundedMilliseconds;
}

export function parseTimestamp(value) {
  const text = String(value).trim();
  const comma = text.includes(',') && text.includes('-->');
  const normalized = comma ? text.replace(',', '.') : text;
  const parts = normalized.split('-->').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const start = parseClockToMs(parts[0]);
  const end = parseClockToMs(parts[1]);
  if (start === null || end === null || end < start) return null;
  return { start, end, rawSettings: '' };
}

export function parseClockToNs(value) {
  const text = String(value).trim().replace(',', '.');
  const match = text.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.](\d+))?$/);
  if (!match) return null;
  const hoursPart = Number(match[1] ?? 0);
  const minutesPart = Number(match[2] ?? (match[1] === undefined ? 0 : match[1]));
  const secondsPart = Number(match[3]);
  const fraction = (match[4] ?? '').padEnd(9, '0').slice(0, 9);
  return ((hoursPart * 60 + minutesPart) * 60 + secondsPart) * 1_000_000_000 + Number(fraction);
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

export function msToSrtTimestamp(ms) {
  if (!Number.isInteger(ms) || ms < 0) throw new Error('Millisecond timestamp must be a non-negative integer');
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const milliseconds = ms % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

export function msToVttTimestamp(ms) {
  return msToSrtTimestamp(ms).replace(',', '.');
}

export function nsToVttTimestamp(ns) {
  const milliseconds = Math.round(ns / 1_000_000);
  const base = msToSrtTimestamp(milliseconds).replace(',', '.');
  if (ns % 1_000_000 === 0) return base;
  const seconds = Math.floor(ns / 1_000_000_000);
  const remainder = String(ns - seconds * 1_000_000_000).padStart(9, '0').replace(/0+$/, '');
  return base.replace(/\.\d{3}$/, '.' + remainder);
}

export function frameStamp(frame, fps) {
  return `${msToFrame(frame.start ?? 0, fps)} --> ${msToFrame(frame.end ?? 0, fps)}`;
}
