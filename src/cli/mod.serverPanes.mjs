import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { TargetError } from './mod.target.mjs';

const execFileP = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const SERVER_STOP_MS = 5_000;
export const SERVER_START_MS = 20_000;

async function lsof(args) {
  try {
    return (await execFileP('lsof', ['-nP', ...args], { timeout: 10_000 })).stdout;
  } catch (err) {
    if (err?.code === 'ENOENT') throw new TargetError('lsof is not installed, so the ports of the server panes cannot be read — nothing was done. Install it:\n  sudo apt-get install -y lsof', 'no-lsof');
    if (err?.code === 1) return err.stdout ?? '';
    throw err;
  }
}

const portsIn = text => [...new Set(text.split('\n').filter(l => l.startsWith('n')).map(l => Number(l.slice(l.lastIndexOf(':') + 1))).filter(Number.isInteger))].sort((a, b) => a - b);

export async function listeningPorts(processGroup) {
  return portsIn(await lsof(['-a', '-g', String(processGroup), '-iTCP', '-sTCP:LISTEN', '-Fn']));
}

export async function portListening(port) {
  return (await lsof([`-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'])).split('\n').some(l => l.startsWith('n'));
}

const answersOn = (port, host) => new Promise(resolve => {
  const socket = connect({ port, host, timeout: 1_000 });
  const done = ok => { socket.destroy(); resolve(ok); };
  socket.on('connect', () => done(true));
  socket.on('timeout', () => done(false));
  socket.on('error', () => done(false));
});

export const portAnswers = async port => (await answersOn(port, '127.0.0.1')) || answersOn(port, '::1');

export async function until(check, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await sleep(200);
  }
}
