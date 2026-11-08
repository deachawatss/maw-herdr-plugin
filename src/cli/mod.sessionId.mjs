import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SAFE_ID } from './mod.resumeLookup.mjs';

export function claudeRegistryId(pid, env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  try {
    const entry = JSON.parse(readFileSync(join(dir, 'sessions', `${pid}.json`), 'utf8'));
    return entry?.pid === pid && typeof entry.sessionId === 'string' && SAFE_ID.test(entry.sessionId) ? entry.sessionId : null;
  } catch {
    return null;
  }
}

export function transcriptOf(providers, kind, path, id) {
  const onlyThisSession = { has: other => other !== id };
  for (const provider of providers.filter(p => p.name === kind)) {
    const session = provider.find([path], onlyThisSession).get(path);
    if (session?.id === id) return session;
  }
  return null;
}
