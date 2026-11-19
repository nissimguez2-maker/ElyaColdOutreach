import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function decimal(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || value.length > 200) throw new Error('Money must be a nonnegative exact decimal string');
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function format(n, scale) {
  const negative = n < 0n; const digits = (negative ? -n : n).toString().padStart(scale + 1, '0');
  const s = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '') : digits;
  return (negative ? '-' : '') + s;
}
export function calculate(a, b, subtract = false) {
  const x = decimal(a), y = decimal(b), scale = Math.max(x.scale, y.scale);
  return format(x.coefficient * 10n ** BigInt(scale - x.scale) + (subtract ? -1n : 1n) * y.coefficient * 10n ** BigInt(scale - y.scale), scale);
}
export const addMoney = (a, b) => calculate(a, b);
export const compareMoney = (a, b) => { const d = calculate(a, b, true); return d.startsWith('-') ? -1 : d === '0' ? 0 : 1; };

const secretKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|bot[_-]?token|authorization|cookie|set-cookie)$/i;
// Reject credential-bearing values even inside prose or embedded provider JSON.
const secretValue = /\bBearer\s+\S+|\b(?:sk-proj-|sk_live_|apify_api_)[A-Za-z0-9_-]+|\b\d{6,12}:[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|[?&](?:token|api_key|apikey|password|secret)=[^&\s]+|https?:\/\/[^\s/@]+:[^\s/@]+@/i;
export function assertSafe(value) {
  if (typeof value === 'string') {
    if (secretValue.test(value)) throw new Error('Credential-like content rejected; value not logged');
    if (/^\s*[\[{]/.test(value)) {
      let parsed; try { parsed = JSON.parse(value); } catch { return; }
      assertSafe(parsed);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (secretKey.test(key) && child !== null && child !== false && child !== '' && child !== '[REDACTED]') throw new Error('Secret field rejected; value not logged');
      assertSafe(child);
    }
  }
}
export function canonical(value) {
  assertSafe(value);
  function encode(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${Array.from(v, encode).join(',')}]`;
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k])}`).join(',')}}`;
    throw new Error('Canonical content requires plain JSON and safe integers; use strings for decimals');
  }
  return encode(value);
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Explicit timestamp with timezone required');
  return Date.parse(value);
}
export function required(value, name = 'value') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  assertSafe(value); return value;
}
// Node's source context preserves numeric tokens before any floating point conversion.
export function parseLossless(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''), (_key, value, context) => typeof value === 'number' ? context.source : value);
}
