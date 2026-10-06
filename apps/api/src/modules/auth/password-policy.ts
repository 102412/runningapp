/**
 * Password rules follow NIST SP 800-63B: length over composition rules, plus a blocklist of
 * well-known passwords and context-specific values. (Length bounds live in the contract schema.)
 */
const COMMON = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    'passw0rd123',
    'qwertyuiop',
    'qwerty1234',
    'qwerty12345',
    '1234567890',
    '12345678910',
    '0123456789',
    'iloveyou12',
    'letmein1234',
    'welcome1234',
    'admin12345',
    'administrator',
    'abc1234567',
    'abcd123456',
    'abcdefghij',
    'asdfghjkl1',
    'zxcvbnm123',
    '1q2w3e4r5t',
    '1qaz2wsx3e',
    'monkey1234',
    'dragon1234',
    'football12',
    'baseball12',
    'basketball',
    'superman12',
    'trustno1234',
    'sunshine12',
    'princess12',
    'running123',
    'marathon12',
    'runningapp',
    'changeme123',
    'passwordpassword',
    'p@ssw0rd123',
    'p@ssword123',
  ].map((p) => p.toLowerCase()),
);

export interface PasswordContext {
  email: string;
  username?: string;
}

/** Returns a human-readable problem, or null when the password is acceptable. */
export function checkPasswordStrength(password: string, context: PasswordContext): string | null {
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common.';
  if (/^(.)\1+$/.test(password)) return 'This password is too repetitive.';
  if (/^\d+$/.test(password)) return 'Use more than just digits.';
  const local = context.email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local))
    return 'The password must not contain your email.';
  const username = context.username?.toLowerCase() ?? '';
  if (username.length >= 4 && lower.includes(username))
    return 'The password must not contain your username.';
  if (new Set(password).size < 5) return 'Use a wider variety of characters.';
  return null;
}
