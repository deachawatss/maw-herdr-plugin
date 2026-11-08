#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeClaudeDir } from '../src/cli/mod.resumeLookup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.MAW_SLEEP_ENTRY || join(root, 'index.mjs');
const runtime = process.execPath;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'maw-sleep-')));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg ?? `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks++; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jobs = [];

try {
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-C', dir, ...a], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', origin);
  const repo = join(tmp, 'ghq', 'github.com', 'org', 'sl-oracle');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README'), 'sleep\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const home = join(tmp, 'home');
  const mawHome = join(tmp, 'maw-state');
  const claudeProjects = join(home, '.claude', 'projects');
  const wt = {};
  const makeWorktree = (name, { ahead = 0, dirty = 0, transcript = `sid-${name}-1` } = {}) => {
    const path = join(repo, 'wt', name);
    git(repo, 'worktree', 'add', '-q', path, '-b', name);
    git(path, 'push', '-q', '-u', 'origin', name);
    for (let i = 0; i < ahead; i++) git(path, 'commit', '-q', '--allow-empty', '-m', `ahead ${i}`);
    for (let i = 0; i < dirty; i++) writeFileSync(join(path, `dirty-${i}.txt`), 'x');
    if (transcript) {
      const dir = join(claudeProjects, encodeClaudeDir(path));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${transcript}.jsonl`), 'y'.repeat(2048));
    }
    wt[name] = path;
  };
  makeWorktree('idle', { ahead: 1, dirty: 2 });
  for (const name of ['busy', 'blk', 'noid', 'secret', 'jobs', 'viaherdr', 'codexa', 'dry', 'nocard', 'gone', 'blockstart']) makeWorktree(name);
  makeWorktree('unwritten', { transcript: null });

  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const stateFile = join(tmp, 'herdr-state.json');
  const callLog = join(tmp, 'calls.jsonl');
  const agentsDir = join(tmp, 'agents');
  mkdirSync(agentsDir);
  const agentSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
let ints = 0;
const bye = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} process.exit(0); };
process.on('SIGINT', () => { if (++ints >= 2) bye(); });
process.on('SIGTERM', bye);
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const id = at !== -1 ? args[at + 1] : process.env.FAKE_SESSION_ID;
if (id && !process.env.FAKE_NO_REGISTRY && /claude$/.test(process.argv[1])) {
  const dir = process.env.HOME + '/.claude/sessions';
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + '/' + process.pid + '.json', JSON.stringify({ pid: process.pid, sessionId: id }));
}
setInterval(() => {}, 1 << 30);
`;
  for (const kind of ['claude', 'codex']) writeFileSync(join(agentsDir, kind), agentSource);
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!${runtime}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const STATE = ${JSON.stringify(stateFile)};
const AGENTS = ${JSON.stringify(agentsDir)};
const RUNTIME = ${JSON.stringify(runtime)};
const SHELL = 999999;
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
const load = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = s => { writeFileSync(STATE + '.tmp', JSON.stringify(s)); renameSync(STATE + '.tmp', STATE); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const session = args[0] === '--session' ? args[1] : 'default';
const rest = args[0] === '--session' ? args.slice(2) : args;
const verb = rest.slice(0, 2).join(' ');
const out = v => console.log(JSON.stringify(v));
const die = (m, c = 1) => { console.error(m); process.exit(c); };
let s = load();
const live = p => s.procs[p] && alive(s.procs[p].pid) ? s.procs[p] : null;
if (session !== 'default') die('fake herdr: no session ' + session);
const sessionOf = pane => s.agentSession[pane] ? { agent: live(pane)?.kind ?? 'x', kind: 'id', value: s.agentSession[pane] } : null;
if (verb === 'session list') out({ sessions: [{ name: 'default', running: true, default: true }] });
else if (verb === 'agent list') {
  const agents = s.panes.filter(p => live(p.pane_id)).map(p => ({ pane_id: p.pane_id, agent: live(p.pane_id).kind, name: s.names[p.pane_id] ?? null, agent_session: sessionOf(p.pane_id) }));
  out({ id: 'cli:agent:list', result: { agents } });
}
else if (verb === 'api snapshot') {
  const panes = s.panes.map(p => ({ ...p, agent: live(p.pane_id)?.kind ?? null, agent_status: live(p.pane_id) ? (s.status[p.pane_id] ?? 'idle') : 'unknown', agent_session: sessionOf(p.pane_id) }));
  const agents = panes.filter(p => p.agent && s.names[p.pane_id]).map(p => ({ pane_id: p.pane_id, name: s.names[p.pane_id] }));
  out({ id: 1, result: { snapshot: { workspaces: s.workspaces, panes, agents } } });
}
else if (verb === 'pane process-info') {
  const pane = rest[rest.indexOf('--pane') + 1];
  const a = live(pane);
  const job = !a && s.jobs[pane] && alive(s.jobs[pane].pid) ? s.jobs[pane] : null;
  const rt = RUNTIME.split('/').pop();
  const procs = a ? [{ pid: a.pid + 100000, argv: ['bun', 'mcp.ts'], argv0: 'bun', name: 'bun' }, { pid: a.pid, argv: a.argv, argv0: rt, name: rt, cmdline: a.argv.join(' ') }]
    : job ? [job] : [{ pid: SHELL, argv: ['-zsh'], argv0: '-zsh', name: 'zsh' }];
  const pg = a ? a.pid : job ? job.pid : SHELL;
  out({ result: { process_info: { pane_id: pane, shell_pid: SHELL, foreground_process_group_id: pg, foreground_processes: procs } } });
}
else if (verb === 'pane get') out({ result: { pane: { pane_id: rest[2], agent_session: sessionOf(rest[2]) } } });
else if (verb === 'pane send-keys') {
  const [pane, key] = [rest[2], rest[3]];
  const a = live(pane);
  if (key === 'ctrl+c' && a) process.kill(a.pid, 'SIGINT');
  out({ ok: true });
}
else if (verb === 'pane read') process.stdout.write('fake viewport\\n');
else if (verb === 'agent start') {
  const name = rest[2];
  const kind = rest[rest.indexOf('--kind') + 1];
  const pane = rest[rest.indexOf('--pane') + 1];
  const dd = rest.indexOf('--');
  const extra = dd === -1 ? [] : rest.slice(dd + 1);
  if (!s.panes.some(p => p.pane_id === pane)) die('fake herdr: no pane ' + pane);
  if (live(pane)) die(JSON.stringify({ error: { code: 'agent_pane_busy' } }));
  if (Object.entries(s.names).some(([p, n]) => n === name && p !== pane && live(p))) die(JSON.stringify({ error: { code: 'agent_name_taken' } }));
  const argv = [AGENTS + '/' + kind, ...extra];
  const child = spawn(RUNTIME, argv, { detached: true, stdio: 'ignore', env: { ...process.env, HERDR_PANE_ID: pane } });
  child.unref();
  s.procs[pane] = { pid: child.pid, argv: [RUNTIME, ...argv], kind };
  s.names[pane] = name;
  s.agentSession[pane] = process.env.FAKE_HERDR_SESSION ?? null;
  s.starts.push({ pane, name, kind, args: extra });
  save(s);
  if (process.env.FAKE_BLOCKED_START) { console.error(JSON.stringify({ error: { code: 'agent_not_ready' } })); process.exit(1); }
  out({ result: { agent: { name, pane_id: pane } } });
}
else if (verb === 'worktree open') {
  const repoRoot = rest[rest.indexOf('--cwd') + 1];
  const path = rest[rest.indexOf('--path') + 1];
  const id = 'wN' + (s.workspaces.length + 1);
  const worktree = { checkout_path: path, repo_name: repoRoot.split('/').pop(), repo_root: repoRoot, is_linked_worktree: path !== repoRoot };
  s.workspaces.push({ workspace_id: id, label: path.split('/').pop(), number: s.workspaces.length + 1, agent_status: 'unknown', active_tab_id: id + ':t1', worktree });
  s.panes.push({ pane_id: id + ':p1', workspace_id: id, tab_id: id + ':t1', cwd: path, focused: false });
  save(s);
  out({ result: { type: 'worktree_opened', already_open: false, workspace: { workspace_id: id }, tab: { tab_id: id + ':t1' }, root_pane: { pane_id: id + ':p1' }, worktree } });
}
else if (verb === 'workspace close') {
  const id = rest[2];
  for (const p of s.panes.filter(p => p.workspace_id === id)) { const a = live(p.pane_id); if (a) process.kill(a.pid, 'SIGKILL'); }
  s.workspaces = s.workspaces.filter(w => w.workspace_id !== id);
  s.panes = s.panes.filter(p => p.workspace_id !== id);
  save(s);
  out({ ok: true });
}
else die('fake herdr: unexpected ' + JSON.stringify(args), 8);
`);
  chmodSync(fake, 0o700);
  const ghqRoot = join(tmp, 'ghq');
  writeFileSync(join(bin, 'ghq'), `#!/bin/sh\n[ "$1" = root ] && echo ${JSON.stringify(ghqRoot)}\n`);
  chmodSync(join(bin, 'ghq'), 0o700);

  const state0 = { workspaces: [], panes: [], procs: {}, names: {}, agentSession: {}, status: {}, starts: [], jobs: {} };
  writeFileSync(stateFile, JSON.stringify(state0));
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const patch = fn => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
  const space = (id, name) => patch(s => {
    s.workspaces.push({ workspace_id: id, label: name, number: 1, agent_status: 'idle', focused: false, active_tab_id: `${id}:t1`, worktree: { checkout_path: wt[name], repo_name: 'sl-oracle', repo_root: repo, is_linked_worktree: true } });
    s.panes.push({ pane_id: `${id}:p1`, workspace_id: id, tab_id: `${id}:t1`, cwd: wt[name], focused: false });
  });

  mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
  const baseEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MAW_HOME: mawHome, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1' };
  const fakeHerdr = (a, extra = {}) => execFileSync(fake, a, { env: { ...baseEnv, ...extra }, encoding: 'utf8' });
  const start = (pane, name, kind, args, extra) => fakeHerdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--', ...args], extra);
  const cli = (args, { env = {} } = {}) => {
    const r = spawnSync(runtime, [entry, ...args], { cwd: tmp, encoding: 'utf8', timeout: 90_000, env: { ...baseEnv, ...env } });
    return { rc: r.status, out: r.stdout, err: r.stderr };
  };
  const calls = () => readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const verbOf = a => (a[0] === '--session' ? a.slice(2) : a).slice(0, 2).join(' ');
  const READS = new Set(['session list', 'api snapshot', 'pane process-info', 'pane get', 'pane read', 'agent list']);
  const mutationsSince = n => calls().slice(n).filter(a => !READS.has(verbOf(a)));
  const cards = () => { const dir = join(mawHome, 'herdr', 'wake'); return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => ({ path: join(dir, n), card: JSON.parse(readFileSync(join(dir, n), 'utf8')) })) : []; };
  const pid = pane => state().procs[pane]?.pid;
  const SKIP = '--dangerously-skip-permissions';

  space('wA', 'idle');
  start('wA:p1', 'idle-bot', 'claude', [SKIP, '--continue', '--effort', 'medium'], { FAKE_SESSION_ID: 'sid-idle-1' });
  const idlePid = pid('wA:p1');
  ok(alive(idlePid), 'the idle agent runs');

  let n = calls().length;
  const secretEnv = { SMOKE_ENV_ONE: 'env-value-one-marker', SMOKE_ENV_TWO: 'env-value-two-marker' };
  let r = cli(['sleep', wt.idle], { env: secretEnv });
  eq(r.rc, 0, `sleep an idle agent: ${r.err}${r.out}`);
  const [written] = cards();
  eq(cards().length, 1, 'one card was written');
  eq(statSync(written.path).mode & 0o777, 0o600, 'the card is private to its owner');
  eq(statSync(dirname(written.path)).mode & 0o777, 0o700, 'its folder is private too');
  ok(!written.path.startsWith(repo), 'the card is outside every repo');
  eq(written.card.state, 'asleep');
  eq(written.card.host, hostname());
  eq(written.card.session, 'default');
  eq(written.card.space, 'idle');
  eq(written.card.cwd, wt.idle);
  eq(written.card.agent, { kind: 'claude', sessionId: 'sid-idle-1', argv: [SKIP, '--continue', '--effort', 'medium'] }, 'the exact session id and argv');
  eq(written.card.git, { branch: 'idle', ahead: 1, dirty: 2 }, 'git state at the sleep');
  ok(Math.abs(Date.parse(written.card.at) - Date.now()) < 60_000, 'the card holds the time of the sleep');
  const text = readFileSync(written.path, 'utf8');
  ok(!text.includes('env-value-one-marker') && !text.includes('env-value-two-marker'), 'no environment value is in the card');
  ok(!('env' in written.card), 'the card has no env field');
  ok(!alive(idlePid), 'the agent is stopped');
  eq(state().workspaces.map(w => w.label), [], 'the space is closed');
  const order = mutationsSince(n).map(verbOf);
  ok(order.indexOf('pane send-keys') !== -1 && order.indexOf('pane send-keys') < order.indexOf('workspace close'), `kill comes before close: ${order}`);
  eq(git(wt.idle, 'status', '--porcelain').split('\n').filter(Boolean).length, 2, 'the dirty files stay dirty');
  eq(git(wt.idle, 'rev-list', '--count', '@{u}..HEAD').trim(), '1', 'no commit and no push');
  ok(existsSync(join(wt.idle, 'dirty-0.txt')) && existsSync(join(wt.idle, 'README')), 'no file was deleted');
  ok(readdirSync(join(claudeProjects, encodeClaudeDir(wt.idle))).includes('sid-idle-1.jsonl'), 'the transcript stays');

  const lastLine = text => text.trim().split('\n').pop();
  const refused = (label, target, expect, setup = () => {}) => {
    const before = calls().length;
    const cardsBefore = cards().length;
    const r = cli(['sleep', target]);
    ok(r.rc !== 0, `${label}: exits non-zero`);
    ok(expect.test(r.err), `${label}: ${r.err}`);
    ok(/^\s*(maw herdr|herdr) /.test(lastLine(r.err)), `${label}: the error ends with a command: ${lastLine(r.err)}`);
    eq(cards().length, cardsBefore, `${label}: no card was written`);
    eq(mutationsSince(before), [], `${label}: nothing was changed`);
  };

  space('wB', 'busy');
  start('wB:p1', 'busy-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-busy-1' });
  patch(s => { s.status['wB:p1'] = 'working'; });
  refused('a working agent', wt.busy, /is working/);
  ok(alive(pid('wB:p1')), 'the working agent still runs');

  space('wC', 'blk');
  start('wC:p1', 'blk-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-blk-1' });
  patch(s => { s.status['wC:p1'] = 'blocked'; });
  refused('a blocked agent', wt.blk, /is blocked/);

  space('wD', 'noid');
  start('wD:p1', 'noid-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-noid-1', FAKE_NO_REGISTRY: '1' });
  refused('an agent whose session id cannot be read', wt.noid, /cannot read the session id/);
  ok(alive(pid('wD:p1')), 'the agent with no readable id still runs');

  space('wE', 'secret');
  start('wE:p1', 'secret-bot', 'claude', [SKIP, '--api-key', 'sk-live-marker-9'], { FAKE_SESSION_ID: 'sid-secret-1' });
  r = cli(['sleep', wt.secret]);
  ok(r.rc !== 0 && /secret in its argv/.test(r.err), `an argv with a secret: ${r.err}`);
  ok(!r.err.includes('sk-live-marker-9') && !r.out.includes('sk-live-marker-9'), 'the refusal prints no secret');
  eq(cards().length, 1, 'no card for the secret agent');

  space('wF', 'jobs');
  start('wF:p1', 'jobs-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-jobs-1' });
  const job = spawn('sleep', ['600'], { stdio: 'ignore' });
  jobs.push(job);
  patch(s => {
    s.panes.push({ pane_id: 'wF:p2', workspace_id: 'wF', tab_id: 'wF:t1', cwd: wt.jobs, focused: false });
    s.jobs['wF:p2'] = { pid: job.pid, argv: ['bun', 'dev-server.ts'], argv0: 'bun', name: 'bun' };
  });
  refused('a space with a server pane', wt.jobs, /running a job/);
  ok(alive(pid('wF:p1')) && alive(job.pid), 'agent and server are untouched');

  space('wG', 'viaherdr');
  start('wG:p1', 'viaherdr-bot', 'claude', [SKIP, '--resume', 'sid-viaherdr-old'], { FAKE_HERDR_SESSION: 'sid-viaherdr-new' });
  const viaTranscript = join(claudeProjects, encodeClaudeDir(wt.viaherdr));
  writeFileSync(join(viaTranscript, 'sid-viaherdr-new.jsonl'), 'z'.repeat(2048));
  r = cli(['sleep', wt.viaherdr]);
  eq(r.rc, 0, `herdr's own session id: ${r.err}`);
  eq(cards().find(c => c.card.space === 'viaherdr').card.agent.sessionId, 'sid-viaherdr-new', 'the id herdr reports wins over the argv');
  eq(cards().find(c => c.card.space === 'viaherdr').card.agent.argv, [SKIP, '--resume', 'sid-viaherdr-old'], 'the argv is stored as read');

  space('wH', 'codexa');
  start('wH:p1', 'codexa-bot', 'codex', ['--yolo', 'resume', 'cx-codexa-1']);
  const codexDir = join(home, '.codex', 'sessions', '2026', '11', '08');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'rollout-2026-11-08T01-00-00-cx-codexa-1.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'cx-codexa-1', cwd: wt.codexa, source: 'cli' } })}\n${'z'.repeat(2048)}\n`);
  r = cli(['sleep', wt.codexa]);
  eq(r.rc, 0, `a codex agent: ${r.err}`);
  eq(cards().find(c => c.card.space === 'codexa').card.agent, { kind: 'codex', sessionId: 'cx-codexa-1', argv: ['--yolo', 'resume', 'cx-codexa-1'] }, 'codex: id from its argv');

  space('wI', 'dry');
  start('wI:p1', 'dry-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-dry-1' });
  n = calls().length;
  const cardsBeforeDry = cards().length;
  r = cli(['sleep', wt.dry, '--dry']);
  eq(r.rc, 0, `--dry: ${r.err}`);
  ok(r.out.includes('--dry: nothing was done') && r.out.includes('"sessionId": "sid-dry-1"') && r.out.includes('workspace close'), `--dry prints the card and the stop plan: ${r.out}`);
  eq(cards().length, cardsBeforeDry, '--dry writes no card');
  eq(mutationsSince(n), [], '--dry changes nothing');
  ok(alive(pid('wI:p1')), '--dry stops nothing');

  space('wJ', 'unwritten');
  start('wJ:p1', 'unwritten-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-unwritten-1' });
  refused('a session with no transcript', wt.unwritten, /no transcript on disk/);
  r = cli(['sleep']);
  ok(r.rc !== 0 && /maw herdr ls --agents/.test(lastLine(r.err)), `no target: ${r.err}`);

  const session = async pane => {
    const file = join(home, '.claude', 'sessions', `${pid(pane)}.json`);
    for (let i = 0; i < 60 && !existsSync(file); i++) await sleep(50);
    return JSON.parse(readFileSync(file, 'utf8')).sessionId;
  };
  const cardOf = space => cards().find(c => c.card.space === space);

  const idleCard = cards().find(c => c.card.space === 'idle');
  n = calls().length;
  r = cli(['resume', wt.idle, '--dry']);
  eq(r.rc, 0, `resume --dry: ${r.err}`);
  ok(r.out.includes(idleCard.path) && r.out.includes('--resume sid-idle-1') && r.out.includes('--dry: nothing was done'), `resume --dry shows the card and the start: ${r.out}`);
  eq(mutationsSince(n), [], 'resume --dry changes nothing');
  eq(cardOf('idle').card.state, 'asleep', 'resume --dry leaves the card asleep');

  r = cli(['resume', wt.idle]);
  eq(r.rc, 0, `resume from a card: ${r.err}${r.out}`);
  const started = state().starts.at(-1);
  eq({ kind: started.kind, args: started.args }, { kind: 'claude', args: [SKIP, '--effort', 'medium', '--resume', 'sid-idle-1'] }, '--continue became --resume <id>; the other flags stay');
  const opened = calls().filter(a => verbOf(a) === 'worktree open').at(-1);
  eq([opened[opened.indexOf('--cwd') + 1], opened[opened.indexOf('--path') + 1]], [repo, wt.idle], 'the space opens at the card cwd');
  const newPane = state().panes.find(p => p.cwd === wt.idle).pane_id;
  eq(await session(newPane), 'sid-idle-1', 'the agent came back on the same session id');
  eq(cardOf('idle').card.state, 'woke', 'the card is marked woke');
  ok(!!cardOf('idle').card.wokeAt, 'with the time of the wake');
  eq(cardOf('idle').card.agent, idleCard.card.agent, 'the card is kept as it was');
  eq(statSync(idleCard.path).mode & 0o777, 0o600, 'a woke card is still private');

  n = calls().length;
  r = cli(['resume', wt.idle]);
  ok(r.rc !== 0 && /already runs/.test(r.err), `resume of a running agent: ${r.err}`);
  eq(mutationsSince(n), [], 'it changes nothing');

  const nocardDir = join(claudeProjects, encodeClaudeDir(wt.nocard));
  await sleep(30);
  writeFileSync(join(nocardDir, 'sid-nocard-newest.jsonl'), 'n'.repeat(4096));
  r = cli(['resume', wt.nocard]);
  eq(r.rc, 0, `resume with no card: ${r.err}${r.out}`);
  eq(state().starts.at(-1).args, ['--resume', 'sid-nocard-newest'], 'no card: the newest transcript, as before');
  ok(!r.out.includes('wake card') && !r.out.includes('    card    '), 'no card: nothing about a card');

  r = cli(['resume', wt.viaherdr]);
  eq(r.rc, 0, `resume the herdr-id card: ${r.err}`);
  eq(state().starts.at(-1).args, [SKIP, '--resume', 'sid-viaherdr-new'], 'the card id replaces the argv id');

  r = cli(['resume', wt.codexa]);
  eq(r.rc, 0, `resume a codex card: ${r.err}`);
  const codexStart = state().starts.at(-1);
  eq({ kind: codexStart.kind, args: codexStart.args }, { kind: 'codex', args: ['--yolo', 'resume', 'cx-codexa-1'] }, 'codex resumes by its card id');
  eq(cardOf('codexa').card.state, 'woke');

  const goneDir = join(claudeProjects, encodeClaudeDir(wt.gone));
  writeFileSync(join(goneDir, 'sid-gone-other.jsonl'), 'o'.repeat(2048));
  space('wL', 'gone');
  start('wL:p1', 'gone-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-gone-1' });
  r = cli(['sleep', wt.gone]);
  eq(r.rc, 0, `sleep before the transcript goes: ${r.err}`);
  rmSync(join(goneDir, 'sid-gone-1.jsonl'));
  n = calls().length;
  const startsBefore = state().starts.length;
  r = cli(['resume', wt.gone]);
  ok(r.rc !== 0 && /sid-gone-1/.test(r.err) && /no transcript/.test(r.err), `a card whose transcript is missing: ${r.err}`);
  ok(/^\s*maw herdr resume \S+ --no-card$/.test(lastLine(r.err)), `it ends with a fix command: ${lastLine(r.err)}`);
  eq(mutationsSince(n), [], 'nothing was opened or started');
  eq(state().starts.length, startsBefore, 'no new conversation began');
  eq(cardOf('gone').card.state, 'asleep', 'the card stays asleep');
  r = cli(['resume', wt.gone, '--no-card']);
  eq(r.rc, 0, `--no-card: ${r.err}`);
  eq(state().starts.at(-1).args, ['--resume', 'sid-gone-other'], '--no-card uses the newest transcript');
  eq(cardOf('gone').card.state, 'asleep', '--no-card leaves the card alone');

  space('wM', 'blockstart');
  start('wM:p1', 'blockstart-bot', 'claude', [SKIP], { FAKE_SESSION_ID: 'sid-blockstart-1' });
  r = cli(['sleep', wt.blockstart]);
  eq(r.rc, 0, `sleep: ${r.err}`);
  r = cli(['resume', wt.blockstart], { env: { FAKE_BLOCKED_START: '1' } });
  ok(r.rc !== 0 && /blocked on a startup screen/.test(r.err), `a start that waits at a screen: ${r.err}`);
  eq(cardOf('blockstart').card.state, 'woke', 'the agent started, so the card is woke');

  console.log(`sleep smoke ok: ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  try {
    const s = JSON.parse(readFileSync(join(tmp, 'herdr-state.json'), 'utf8'));
    for (const a of Object.values(s.procs)) { try { process.kill(-a.pid, 'SIGKILL'); } catch {} try { process.kill(a.pid, 'SIGKILL'); } catch {} }
  } catch {}
  for (const job of jobs) { try { process.kill(job.pid, 'SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
}
