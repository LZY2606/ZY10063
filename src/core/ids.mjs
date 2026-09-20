import { randomBytes } from 'node:crypto';

export function randomId(prefix) {
  const bytes = randomBytes(12).toString('hex');
  return prefix + '_' + bytes;
}
