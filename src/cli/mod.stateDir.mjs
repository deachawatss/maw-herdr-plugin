import { homedir } from 'node:os';
import { join } from 'node:path';

export function mawStateDir(env = process.env) {
  const home = env.HOME || homedir();
  const xdg = ['1', 'true', 'yes', 'on'].includes((env.MAW_XDG || '').toLowerCase());
  return env.MAW_HOME || env.MAW_STATE_DIR || (xdg ? join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'maw') : join(home, '.maw'));
}
