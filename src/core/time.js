// 时间与帧号换算。所有内部时间统一为整数毫秒，避免浮点漂移。

export function parseTimestamp(str) {
  const m = /^\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/.exec(str);
  if (!m) throw new Error(`无法解析时间戳: ${JSON.stringify(str)}`);
  const [, h, mm, s, msRaw] = m;
  const ms = msRaw.padEnd(3, '0');
  return ((Number(h) * 60 + Number(mm)) * 60 + Number(s)) * 1000 + Number(ms);
}

export function formatTimestamp(ms, sep = ',') {
  const total = Math.round(ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor(total / 60000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const mmm = total % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(mmm, 3)}`;
}

export function frameToMs(frame, fps) {
  return Math.round((frame * 1000) / fps);
}

export function msToFrame(ms, fps) {
  return Math.round((ms * fps) / 1000);
}

// 规范化 fps 文本，如 "23.976"、"24000/1001"
export function parseFps(str) {
  if (typeof str === 'number') return str;
  const s = String(str).trim();
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (!a || !b) throw new Error(`非法 fps: ${str}`);
    return a / b;
  }
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`非法 fps: ${str}`);
  return v;
}
