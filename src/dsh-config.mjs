// Runtime configuration for launching DeepSeek Harness (DSH) as a bounded executor.
//
// This module is intentionally free of subprocess logic so that configuration
// resolution, validation and error messages can be unit-tested offline.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG_FILENAME = 'bridge.config.json';
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_TIMEOUT_MS = 1_800_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 3_600_000;

/**
 * Path of the runtime configuration.
 *
 * `DSH_BRIDGE_CONFIG_PATH` wins (used by tests and by multi-project setups),
 * otherwise `<repo>/bridge.config.json`.
 */
export function defaultConfigPath(env = process.env) {
  if (env.DSH_BRIDGE_CONFIG_PATH) return resolve(env.DSH_BRIDGE_CONFIG_PATH);
  return join(REPO_ROOT, DEFAULT_CONFIG_FILENAME);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeTimeout(value, label) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < MIN_TIMEOUT_MS || number > MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return number;
}

/**
 * Validate and normalise a raw configuration object.
 *
 * Only `executable`, `prefixArgs`/`entry`, `profile` and `home` are required.
 * The returned object is what `runDsh` consumes; unknown keys are dropped so
 * that a hand-edited config cannot smuggle new spawn behaviour into the worker.
 */
export function normalizeRuntimeConfig(raw, source = 'bridge config', env = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object`);
  }

  const executable = requireString(raw.executable, `${source}.executable`);
  const profile = requireString(raw.profile, `${source}.profile`);
  const home = requireString(raw.home, `${source}.home`);

  let prefixArgs = raw.prefixArgs;
  if (prefixArgs === undefined) {
    const entry = requireString(raw.entry, `${source}.entry`);
    prefixArgs = ['--expose-internals', entry];
  }
  if (!Array.isArray(prefixArgs) || prefixArgs.length === 0) {
    throw new Error(`${source}.prefixArgs must be a non-empty array of strings`);
  }
  for (const [index, arg] of prefixArgs.entries()) {
    if (typeof arg !== 'string' || arg.length === 0) {
      throw new Error(`${source}.prefixArgs[${index}] must be a non-empty string`);
    }
  }

  if (raw.mode != null && raw.mode !== 'desktop' && raw.mode !== 'node') {
    throw new Error(`${source}.mode must be "desktop" or "node"`);
  }

  const timeoutSource = raw.timeoutMs ?? env.DSH_BRIDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrency=Number(env.DSH_BRIDGE_MAX_CONCURRENCY ?? raw.maxConcurrency ?? 4);
  if(!Number.isInteger(maxConcurrency)||maxConcurrency<1||maxConcurrency>5)throw new Error('maxConcurrency must be an integer 1..5');
  if(raw.permissionMode&&raw.permissionMode!=='workspace-write')throw new Error('This executor requires workspace-write confinement');

  return {
    mode: raw.mode ?? null,
    executable,
    prefixArgs: [...prefixArgs],
    profile,
    home,
    timeoutMs: normalizeTimeout(timeoutSource, `${source}.timeoutMs`),
    permissionMode: 'workspace-write',
    maxConcurrency,
    stateDir: resolve(raw.stateDir ?? env.DSH_BRIDGE_STATE_DIR ?? join(REPO_ROOT,'.state')),
    heartbeatMs: normalizeTimeout(raw.heartbeatMs ?? 5000,'heartbeatMs'),
    stallWarningMs: normalizeTimeout(raw.stallWarningMs ?? 180000,'stallWarningMs'),
  };
}

/** Read and validate the runtime configuration from disk. */
export async function readRuntimeConfig(path = defaultConfigPath(), env = process.env) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Runtime config not found at ${path}. Run "node setup.mjs --help" (or "npm run setup -- --help") to generate one.`,
      );
    }
    throw error;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Runtime config at ${path} is not valid JSON: ${error.message}`);
  }
  return normalizeRuntimeConfig(raw, path, env);
}
