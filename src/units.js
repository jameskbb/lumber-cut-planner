// Length parsing and formatting. Inches are shown as fractions to the nearest
// 1/32; millimetres to one decimal place.

export const MM_PER_IN = 25.4;
export const UNITS = {
  in: { name: 'Inches', short: 'in' },
  mm: { name: 'Millimetres', short: 'mm' },
};

// "23", "23.5", ".5", "23 5/8", "23-5/8", "5/8"
function parseMixed(s) {
  s = s.trim();
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d*)?|\.\d+)$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(?:(\d+)(?:\s+|\s*-\s*))?(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    const den = parseInt(m[3], 10);
    if (!den) return null;
    return (m[1] ? parseInt(m[1], 10) : 0) + parseInt(m[2], 10) / den;
  }
  return null;
}

/**
 * Parses a length typed by a person into a number in `units`.
 * Accepts fractions, feet and inches (4', 2' 6"), and metric suffixes (600mm, 60cm)
 * in either unit system. Returns null when the text isn't a length.
 */
export function parseLength(input, units = 'in') {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[”″]|''/g, '"')
    .replace(/[’′]/g, "'")
    .replace(/,/g, '.');
  if (!s) return null;

  const toTarget = (value, from) => {
    if (value === null) return null;
    if (from === units) return value;
    return from === 'in' ? value * MM_PER_IN : value / MM_PER_IN;
  };

  let m = s.match(/^(.*?)\s*(mm|cm|m)$/);
  if (m) {
    const v = parseMixed(m[1]);
    if (v === null) return null;
    return toTarget(v * { mm: 1, cm: 10, m: 1000 }[m[2]], 'mm');
  }

  m = s.match(/^(.*?)\s*(?:'|ft|feet|foot)\s*(.*)$/);
  if (m) {
    const feet = parseMixed(m[1]);
    const restText = m[2].replace(/\s*(?:"|in|inch|inches)$/, '');
    const inches = restText.trim() ? parseMixed(restText) : 0;
    if (feet === null || inches === null) return null;
    return toTarget(feet * 12 + inches, 'in');
  }

  m = s.match(/^(.*?)\s*(?:"|in|inch|inches)$/);
  if (m) return toTarget(parseMixed(m[1]), 'in');

  return parseMixed(s);
}

function inchParts(value) {
  const t = Math.round(value * 32);
  const whole = Math.floor(t / 32);
  let num = t - whole * 32;
  let den = 32;
  while (num && num % 2 === 0) { num /= 2; den /= 2; }
  return { whole, num, den, approx: Math.abs(value - t / 32) > 1e-4 };
}

/** Plain-text length, e.g. "23 5/8" or "600.5". Used for inputs and exports. */
export function formatLength(value, units = 'in') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  if (units === 'mm') return String(Math.round(value * 10) / 10);
  const { whole, num, den } = inchParts(value);
  if (!num) return String(whole);
  return whole ? `${whole} ${num}/${den}` : `${num}/${den}`;
}

/**
 * Length split for typesetting: {whole, frac, approx}. `frac` is "num/den" or
 * null. `whole` is "" when the value is a pure fraction.
 */
export function lengthParts(value, units = 'in') {
  if (units === 'mm') {
    const r = Math.round(value * 10) / 10;
    return { whole: String(r), frac: null, approx: Math.abs(value - r) > 1e-4 };
  }
  const { whole, num, den, approx } = inchParts(value);
  return { whole: num && !whole ? '' : String(whole), frac: num ? `${num}/${den}` : null, approx };
}

export function convertLength(value, from, to) {
  if (from === to) return value;
  return from === 'in' ? value * MM_PER_IN : value / MM_PER_IN;
}
