import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/config';

describe('loadDotEnv', () => {
  const touched = ['DOTENV_TEST_NEW', 'DOTENV_TEST_KEPT'];
  afterEach(() => {
    for (const k of touched) delete process.env[k];
    process.env.NODE_ENV = 'test';
  });

  const envFile = (body: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dotenv-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, body);
    return { file, dir };
  };

  it('loads values for local development but never overrides real environment variables', () => {
    const { file, dir } = envFile('DOTENV_TEST_NEW=from-file\nDOTENV_TEST_KEPT=from-file\n');
    process.env.DOTENV_TEST_KEPT = 'from-shell';
    loadDotEnv(file);
    expect(process.env.DOTENV_TEST_NEW).toBe('from-file');
    expect(process.env.DOTENV_TEST_KEPT).toBe('from-shell');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op in production and when the file does not exist', () => {
    const { file, dir } = envFile('DOTENV_TEST_NEW=should-not-load\n');
    process.env.NODE_ENV = 'production';
    loadDotEnv(file);
    expect(process.env.DOTENV_TEST_NEW).toBeUndefined();
    process.env.NODE_ENV = 'test';
    expect(() => loadDotEnv(path.join(dir, 'missing.env'))).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
