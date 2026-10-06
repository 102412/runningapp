import pg from 'pg';
import { loadConfig, loadDotEnv } from '../src/config';

/**
 * Operator tool: grants or revokes a staff role. There is deliberately NO API for this - the
 * ability to create moderators/admins must not be reachable from the internet.
 *
 *   pnpm --filter @runningapp/api admin:grant -- --email you@example.com --role ADMIN
 *   pnpm --filter @runningapp/api admin:grant -- --email you@example.com --role USER   (revoke)
 *
 * Uses DATABASE_URL like every other script. The change is logged to stdout; keep that log.
 */
const ROLES = ['USER', 'MODERATOR', 'ADMIN'] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const email = arg('email')?.trim().toLowerCase();
const role = arg('role')?.trim().toUpperCase();
if (!email || !role || !(ROLES as readonly string[]).includes(role)) {
  console.error('Usage: admin:grant --email <address> --role <USER|MODERATOR|ADMIN>');
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
try {
  const before = await pool.query<{ id: string; role: string }>(
    'select id, role from users where email = $1',
    [email],
  );
  const user = before.rows[0];
  if (!user) {
    console.error(`No user with email ${email}.`);
    process.exit(1);
  }
  await pool.query('update users set role = $1::user_role where id = $2', [role, user.id]);
  console.log(
    `${new Date().toISOString()} role of user ${user.id} changed ${user.role} -> ${role} (by operator via admin:grant)`,
  );
} finally {
  await pool.end();
}
