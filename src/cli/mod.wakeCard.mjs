import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { git } from './mod.git.mjs';
import { mawStateDir } from './mod.stateDir.mjs';

export const CARD_VERSION = 1;

export const wakeCardDir = (env = process.env) => join(mawStateDir(env), 'herdr', 'wake');

const slug = text => String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'space';

export async function gitState(cwd) {
  try {
    const branch = (await git(cwd, ['branch', '--show-current'])).trim() || null;
    const dirty = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
    let ahead = null;
    try { ahead = Number((await git(cwd, ['rev-list', '--count', '@{upstream}..HEAD'])).trim()); } catch {}
    return { branch, ahead, dirty };
  } catch {
    return null;
  }
}

export function buildCard({ session, space, cwd, kind, sessionId, argv, git: gitInfo, at = new Date() }) {
  return {
    version: CARD_VERSION,
    state: 'asleep',
    at: at.toISOString(),
    host: hostname(),
    session,
    space,
    cwd,
    agent: { kind, sessionId, argv },
    git: gitInfo,
  };
}

export function cardPath(card, env = process.env) {
  return join(wakeCardDir(env), `${card.at.replace(/[:.]/g, '-')}-${slug(card.session)}-${slug(card.space)}.json`);
}

export function writeCard(card, env = process.env) {
  const path = cardPath(card, env);
  mkdirSync(wakeCardDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

export function findAsleepCard(cwd, env = process.env) {
  const dir = wakeCardDir(env);
  let names;
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return null; }
  const found = [];
  for (const name of names) {
    const path = join(dir, name);
    let card;
    try { card = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (card?.state === 'asleep' && card.host === hostname() && card.cwd === cwd) found.push({ path, card });
  }
  found.sort((a, b) => (a.card.at < b.card.at ? 1 : -1));
  return found.length ? { ...found[0], older: found.slice(1) } : null;
}

export function markWoke({ path, card, older = [] }, at = new Date()) {
  for (const target of [{ path, card }, ...older]) {
    const woke = { ...target.card, state: 'woke', wokeAt: at.toISOString() };
    writeFileSync(`${target.path}.tmp`, `${JSON.stringify(woke, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${target.path}.tmp`, 0o600);
    renameSync(`${target.path}.tmp`, target.path);
  }
}
