import { spawn } from 'node:child_process';

/** Last part of stderr kept for error messages (FFmpeg is chatty). */
const STDERR_TAIL = 2000;

export class ProcessError extends Error {
  readonly stderrTail: string;
  constructor(message: string, stderrTail: string) {
    super(message);
    this.name = 'ProcessError';
    this.stderrTail = stderrTail;
  }
}

/**
 * Runs a program with arguments as an array: no shell, so file names can
 * never be interpreted as commands. Kills it after `timeoutSeconds`.
 */
export function run(
  command: string,
  args: string[],
  timeoutSeconds: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ProcessError(`${command} could not start: ${err.message}`, ''));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const why = signal ? `killed (${signal}, timeout ${timeoutSeconds}s)` : `exit code ${code}`;
        const last = stderr.trim().split('\n').at(-1) ?? '';
        reject(new ProcessError(`${command} failed: ${why}${last ? `: ${last}` : ''}`, stderr));
      }
    });
  });
}
