/** URL helpers for the test database cluster. Override with TEST_DATABASE_URL. */
const DEFAULT_URL = 'postgres://runningapp:runningapp@localhost:5432/runningapp';

export const TEMPLATE_DB = 'runningapp_test_template';

function base(): URL {
  return new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_URL);
}

/** Connection to the maintenance DB, used to create/drop databases. */
export function adminUrl(): string {
  const url = base();
  url.pathname = '/postgres';
  return url.toString();
}

export function withDatabase(name: string): string {
  const url = base();
  url.pathname = `/${name}`;
  return url.toString();
}
