import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withSession } from './mod.agentArgv.mjs';

const PLAIN_ARG = /^[A-Za-z0-9._=/:@+-]+$/;
const CONFIG_FILE = /^maw\.config(\.[^/]*)?\.json$/;

function mawDefaultCommand(env) {
  const dir = env.MAW_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'maw');
  let files;
  try { files = readdirSync(dir).filter(name => CONFIG_FILE.test(name)).sort(); } catch { return null; }
  let command = null;
  for (const name of files) {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.commands?.default;
      if (typeof value === 'string') command = value;
    } catch {}
  }
  return command;
}

export function defaultCommandAlternatives(engine, env = process.env) {
  const command = mawDefaultCommand(env);
  if (!command) return [];
  return command.split('||').map(part => part.trim().split(/\s+/)).filter(words => words[0] === engine && words.slice(1).every(word => PLAIN_ARG.test(word))).map(words => words.slice(1));
}

export function resumeArgs(engine, id, env = process.env) {
  return withSession(engine, defaultCommandAlternatives(engine, env)[0] ?? [], id).args;
}
