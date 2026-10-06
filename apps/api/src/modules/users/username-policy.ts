import { USERNAME_PATTERN } from '@runningapp/contracts';

/** Handles that would collide with routes, impersonate staff, or mislead. Compared case-insensitively. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'help',
  'staff',
  'team',
  'official',
  'moderator',
  'mod',
  'security',
  'abuse',
  'postmaster',
  'noreply',
  'no_reply',
  'null',
  'undefined',
  'runningapp',
  'api',
  'www',
  'me',
  'settings',
  'search',
  'explore',
  'feed',
  'posts',
  'post',
  'users',
  'user',
  'activities',
  'activity',
  'notifications',
  'about',
  'terms',
  'privacy',
  'login',
  'logout',
  'signup',
  'register',
  'verify',
  'reset',
  'media',
  'static',
  'assets',
  'health',
]);

export type UsernameProblem = 'INVALID' | 'RESERVED';

export function checkUsername(username: string): UsernameProblem | null {
  if (!USERNAME_PATTERN.test(username) || username.includes('..') || username.endsWith('.')) {
    return 'INVALID';
  }
  if (RESERVED.has(username.toLowerCase())) return 'RESERVED';
  return null;
}
