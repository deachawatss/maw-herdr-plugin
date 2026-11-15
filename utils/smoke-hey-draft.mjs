#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAFT_POLL_MS, DRAFT_WAIT_MS, inputRowState, waitForEmptyInput } from '../src/cli/mod.draftGuard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MAW_HEY_DRAFT_ENTRY || join(root, 'index.mjs');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-hey-draft-')));
let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

const screen = row => `some output\n${'─'.repeat(40)}\n${row}\n${'─'.repeat(40)}\n  footer\n`;
const dim = '\x1b[2m', off = '\x1b[0m';

try {
  eq(inputRowState(screen('❯ ')), 'empty', 'a bare prompt row is empty');
  eq(inputRowState(screen('❯')), 'empty', 'a prompt row with no space is empty');
  eq(inputRowState(screen('❯ it must be')), 'draft', 'text after the prompt is a draft');
  eq(inputRowState(`${screen('❯ old draft')}❯ \n`), 'empty', 'the last prompt row decides');
  eq(inputRowState(`${screen('❯ ')}❯ typed later\n`), 'draft', 'the last prompt row decides');
  eq(inputRowState(`❯ ${dim}Try "fix lint"${off}\n`), 'empty', 'dim placeholder text is not a draft');
  eq(inputRowState('building...\nno prompt here\n'), 'none', 'no prompt row is none');
  eq(inputRowState(''), 'none', 'an empty screen is none');

  const drive = async states => {
    const screens = states.map(s => (s === 'draft' ? screen('❯ half typed') : s === 'empty' ? screen('❯ ') : 'output only\n'));
    const naps = [];
    let reads = 0;
    const outcome = await waitForEmptyInput({
      read: () => screens[Math.min(reads++, screens.length - 1)],
      sleep: async ms => { naps.push(ms); },
      pollMs: 5, waitMs: 20,
    });
    return { outcome, naps, reads };
  };
  eq(await drive(['empty']), { outcome: 'send', naps: [], reads: 1 }, 'empty row sends at once');
  eq(await drive(['none']), { outcome: 'send', naps: [], reads: 1 }, 'no prompt row sends at once');
  eq(await drive(['draft', 'draft', 'empty']), { outcome: 'send', naps: [5, 5], reads: 3 }, 'a draft that empties then sends');
  eq(await drive(['draft']), { outcome: 'draft', naps: [5, 5, 5, 5], reads: 5 }, 'a draft that stays hits the deadline');
  ok(DRAFT_POLL_MS > 0 && DRAFT_WAIT_MS >= DRAFT_POLL_MS, 'limits are usable');

  const bin = join(temporary, 'bin'), home = join(temporary, 'home');
  mkdirSync(bin); mkdirSync(home);
  const reads = join(temporary, 'reads'), screens = join(temporary, 'screens.json'), calls = join(temporary, 'calls.jsonl');
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
const out = v => console.log(JSON.stringify(v));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(rest) + '\\n');
if (verb === 'session list') out({ sessions: [{ name: 'default', running: true, default: true }] });
else if (verb === 'api snapshot') out({ result: { snapshot: {
  workspaces: [{ workspace_id: 'w1', label: 'probe' }],
  panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'claude', agent_status: 'idle' }],
  agents: [{ pane_id: 'w1:p1', name: 'probe-agent' }] } } });
else if (verb === 'pane read') {
  const list = JSON.parse(readFileSync(${JSON.stringify(screens)}, 'utf8'));
  const n = existsSync(${JSON.stringify(reads)}) ? Number(readFileSync(${JSON.stringify(reads)}, 'utf8')) : 0;
  writeFileSync(${JSON.stringify(reads)}, String(n + 1));
  process.stdout.write(list[Math.min(n, list.length - 1)]);
} else if (verb === 'agent prompt') out({ ok: true });
else { console.error('fake herdr: unexpected ' + args.join(' ')); process.exit(97); }
`, { mode: 0o755 });
  chmodSync(join(bin, 'herdr'), 0o755);
  symlinkSync(Bun.which('bash'), join(bin, 'bash'));
  const env = { PATH: bin, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: temporary, MAW_HERDR_DRAFT_POLL_MS: '50', MAW_HERDR_DRAFT_WAIT_MS: '300' };

  const hey = (rows, ...extra) => {
    for (const f of [reads, calls]) rmSync(f, { force: true });
    writeFileSync(screens, JSON.stringify(rows));
    const r = spawnSync(process.execPath, [entry, 'hey', 'probe-agent', ...extra, 'probe text'], { cwd: temporary, env, encoding: 'utf8', timeout: 20_000 });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    return { ...r, prompts: log.filter(c => c[0] === 'agent' && c[1] === 'prompt'), readCount: log.filter(c => c[0] === 'pane' && c[1] === 'read').length };
  };
  const empty = screen('❯ '), draft = screen('❯ half typed message');

  let r = hey([empty]);
  eq(r.status, 0, `empty row exits 0: ${r.stderr}`);
  eq(r.prompts, [['agent', 'prompt', 'w1:p1', 'probe text']], 'empty row types the text');

  r = hey([draft, draft, empty]);
  eq(r.status, 0, `draft that empties exits 0: ${r.stderr}`);
  eq(r.prompts.length, 1, 'a draft that empties then sends once');
  ok(r.readCount >= 3, 'it read again while the draft stayed');

  r = hey([draft]);
  ok(r.status !== 0 && r.status !== null, 'a draft that stays exits non-zero');
  eq(r.prompts, [], 'a draft that stays types nothing');
  ok(r.stderr.includes('w1:p1') && r.stderr.includes('draft'), `the error names the pane and the draft: ${r.stderr}`);
  ok(r.stderr.includes(`maw herdr hey w1:p1 'probe text'`), `the error ends with a command to send again: ${r.stderr}`);

  r = hey(['agent is writing output\n']);
  eq(r.status, 0, `no prompt row exits 0: ${r.stderr}`);
  eq(r.prompts.length, 1, 'no prompt row types the text');

  r = hey([draft], '--dry');
  eq(r.status, 0, `--dry exits 0: ${r.stderr}`);
  eq(r.prompts, [], '--dry types nothing');
  ok(r.stdout.includes('draft'), `--dry reports the draft: ${r.stdout}`);

  console.log(`ok — hey draft guard: ${checks} checks`);
} catch (error) {
  console.error(`hey draft guard: ${error.message}\n  bun ${fileURLToPath(import.meta.url)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
