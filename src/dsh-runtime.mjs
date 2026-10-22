// Direct headless launch. Prompts travel over UTF-8 stdin, never a shell.
import { spawn, spawnSync } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { defaultConfigPath, normalizeRuntimeConfig, readRuntimeConfig } from './dsh-config.mjs';
import { HeadlessMonitor } from './headless-monitor.mjs';

export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const active = new Set();
function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    if (result.status !== 0) child.kill();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
export function stopDshChildren() { for (const child of active) killTree(child); }

export async function runDsh(prompt, options = {}) {
  const { cwd, signal, extraEnv = {}, onUpdate = () => {} } = options;
  const config = options.runtimeConfig
    ? normalizeRuntimeConfig(options.runtimeConfig, 'runtimeConfig')
    : await readRuntimeConfig(options.configPath ?? defaultConfigPath());
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('timeoutMs must be an integer 1000..3600000');
  if (signal?.aborted) throw Object.assign(new Error('Delegated execution cancelled before launch'), { kind: 'cancelled' });

  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const monitor = new HeadlessMonitor();
    const child = spawn(config.executable, [...config.prefixArgs, '--profile', config.profile, '--json'], {
      cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: config.home,
        DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1',
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
    });
    active.add(child);
    let bytes = 0, stderr = '', abortReason = null, launchError = null, settled = false;
    let updates = Promise.resolve();
    const stop = (reason) => { abortReason ??= reason; killTree(child); };
    const notify = () => {
      const snapshot = monitor.snapshot();
      const data = { ...snapshot, pid: child.pid ?? null, processAlive: child.pid !== undefined && child.exitCode === null && child.signalCode === null,
        startedAt, lastHeartbeatAt: Date.now(), suspectedStall: Date.now() - (snapshot.lastActivityAt ?? startedAt) > config.stallWarningMs };
      updates = updates.then(() => onUpdate(data)).catch(() => stop('monitor_error'));
    };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    // Recheck after attaching so cancellation cannot race the initial check.
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const heartbeat = setInterval(notify, config.heartbeatMs);
    timer.unref(); heartbeat.unref();
    notify();
    const finish = async (exitCode, exitSignal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort); active.delete(child);
      monitor.flush(); notify(); await updates;
      const outcome = monitor.finish({ exitCode, signal: exitSignal, abortReason });
      const metadata = { ...outcome.metadata, pid: child.pid ?? null, processAlive: false, startedAt, finishedAt: Date.now(), exitCode, exitSignal };
      let kind = abortReason ?? outcome.kind;
      let message = outcome.message;
      if (launchError) { kind = ['EACCES', 'EPERM'].includes(launchError.code) ? 'permission_denied' : 'launch_error'; message = `Worker launch failed (${launchError.code ?? 'unknown'})`; }
      else if (abortReason === 'timeout') message = `Delegated execution timed out after ${timeoutMs}ms`;
      else if (abortReason === 'output_limit') message = `Delegated output exceeded ${MAX_OUTPUT_BYTES} bytes`;
      else if (abortReason === 'monitor_error') message = 'Cannot persist worker monitoring state; execution stopped';
      if (launchError || abortReason || !outcome.ok) {
        rejectPromise(Object.assign(new Error(message), { kind, metadata }));
      } else resolvePromise({ stdout: outcome.text, stderr, metadata });
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop('output_limit'); return; }
      monitor.push(chunk); notify();
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop('output_limit'); return; }
      // Internal diagnostics only. The MCP response/ledger never includes stderr.
      stderr = (stderr + chunk.toString('utf8')).slice(-16384);
    });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') { launchError ??= error; stop('io_error'); } });
    child.once('error', (error) => { launchError ??= error; if (!child.pid) void finish(null, null); });
    child.once('close', (code, sig) => { void finish(code, sig); });
    child.stdin.end(prompt, 'utf8');
  });
}
