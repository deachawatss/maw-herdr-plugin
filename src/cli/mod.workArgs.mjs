import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredProviders, findSessions } from './mod.resumeProviders.mjs';

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

function alternatives(command, engine) {
  return command.split('||').map(part => part.trim().split(/\s+/)).filter(words => words[0] === engine && words.slice(1).every(word => PLAIN_ARG.test(word))).map(words => words.slice(1));
}

const hasTranscript = (engine, path, env) => {
  const providers = configuredProviders(env).filter(provider => provider.name === engine);
  return findSessions(providers, new Map([[path, path]])).has(path);
};

export function workAgentArgs(engine, path, env = process.env) {
  const command = mawDefaultCommand(env);
  if (!command) return [];
  const choices = alternatives(command, engine);
  const usable = choices.find(args => !args.includes('--continue') || hasTranscript(engine, path, env));
  return usable ?? [];
}
