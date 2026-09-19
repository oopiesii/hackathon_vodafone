import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function encrypt(value: string) {
  const key = Buffer.from(env.TG_SESSION_KEY, 'base64url');
  if (key.length !== 32) throw new Error('invalid_session_key');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const content = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['gcm1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),content.toString('base64url')].join('.');
}
