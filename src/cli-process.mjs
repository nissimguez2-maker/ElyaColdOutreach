import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { canonical } from './values.mjs';

/** Trusted composition only; never construct executable/prefixArgs from a job or model output.
 * Default mode is live, which executeCliJob currently refuses before starting any process.
 * Offline tests supply the Node executable and a harmless fixture script.
 */
export function createCliProcessTransport({ executable, prefixArgs = [], workingDirectory, mode = 'live' }) {
  if (!isAbsolute(executable) || !isAbsolute(workingDirectory) || !Array.isArray(prefixArgs) || prefixArgs.some(x => typeof x !== 'string') || !['live','offline'].includes(mode)) throw new Error('INVALID_PROCESS_CONFIGURATION');
  const prefix = [...prefixArgs];
  return Object.freeze({ mode, start(request, handlers) {
    // The adapter compiles this request. No shell interpolation or credentials are supplied.
    const directory = mkdtempSync(join(tmpdir(), 'elya-cli-schema-'));
    const schemaFile = join(directory, 'result.schema.json');
    writeFileSync(schemaFile, canonical(request.outputSchema), { flag: 'wx' });
    const child = spawn(executable, [...prefix, ...request.args, '--output-schema', schemaFile, '-'], {
      cwd: workingDirectory, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe']
    });
    let buffer = '', bytes = 0, dropped = false, closedAlready = false, terminationPromise;
    const closed = new Promise(resolve => {
      child.on('error', () => handlers.diagnostic('PROCESS_START_FAILED'));
      child.on('close', (exitCode, signal) => {
        closedAlready = true;
        if (!dropped && buffer.trim()) handlers.line(buffer);
        resolve({ exitCode, signal, interrupted: dropped });
      });
    });
    async function terminate() {
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        if (closedAlready) return true;
        if (!child.pid) return false;
        if (process.platform === 'win32') {
          // Only this driver's own child process tree, not another application or a service.
          const killed = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows','System32','taskkill.exe'), ['/PID',String(child.pid),'/T','/F'], { windowsHide: true, stdio: 'ignore', timeout: 500 });
          if (killed.status !== 0 && !closedAlready) {
            // Existing child handle can stop the direct child; it cannot prove descendants ended.
            child.kill('SIGKILL'); return false;
          }
        } else if (!child.kill('SIGKILL') && !closedAlready) return false;
        await closed; return true;
      })();
      return terminationPromise;
    }
    child.stdout.on('data', chunk => {
      if (dropped) return;
      bytes += chunk.length;
      buffer += chunk.toString('utf8');
      if (bytes > 2_000_000 || buffer.length > 256_000) {
        dropped = true; buffer = ''; handlers.diagnostic('OUTPUT_LIMIT_EXCEEDED'); void terminate(); return;
      }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) { handlers.line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
    });
    child.stderr.on('data', chunk => handlers.diagnostic(chunk.toString('utf8').slice(0,8192)));
    child.stdin.on('error', () => handlers.diagnostic('PROCESS_INPUT_CLOSED'));
    child.stdin.end(request.prompt);
    return { closed, terminate };
  } });
}
