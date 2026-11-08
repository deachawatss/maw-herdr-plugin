#!/usr/bin/env bun
// maw herdr work (#101) through the actual CLI process. FAKE herdr and ghq lead PATH and
// record every call; git is real, on throwaway repos under a temporary ghq root. HOME is
// temporary; no live herdr session is touched. --dry must run nothing but the two reads.
// Run: bun utils/smoke-work.mjs (MAW_WORK_ENTRY=<bundle> for the bundle).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(process.env.MAW_WORK_ENTRY || join(root, 'index.mjs'));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'maw-herdr-work-')));
const bin = join(temporary, 'bin'), home = join(temporary, 'home'), ghq = join(temporary, 'ghq');
const herdrLog = join(temporary, 'herdr-calls.jsonl'), ghqLog = join(temporary, 'ghq-calls.jsonl');
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const calls = (log) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const reset = () => { rmSync(herdrLog, { force: true }); rmSync(ghqLog, { force: true }); };

try {
  mkdirSync(bin); mkdirSync(home); mkdirSync(ghq);
  // herdr: the two reads answer; create/start/prompt answer like herdr does; anything else fails.
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(herdrLog)}, JSON.stringify(argv) + '\\n');
const a = argv[0] === '--session' ? argv.slice(2) : argv;
const say = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
if (a[0] === 'session' && a[1] === 'list') say({ sessions: process.env.FAKE_NO_SESSION ? [{ name: 'default', running: false, default: true }] : [{ name: 'default', running: true, default: true, socket_path: process.env.FAKE_SOCKET }, { name: 'old', running: false }] });
if (a[0] === 'pane' && a[1] === 'list') say({ result: { panes: JSON.parse(process.env.FAKE_PANES || '[]') } });
if (a[0] === 'workspace' && a[1] === 'create') say({ result: { root_pane: { pane_id: 'wT:p1' } } });
if (a[0] === 'agent' && a[1] === 'start') {
  // what real herdr printed (2026-10-03) for Claude Code at its folder-trust question in a fresh clone
  if (process.env.FAKE_AGENT_START === 'blocked') { process.stderr.write(JSON.stringify({ error: { code: 'agent_not_ready', message: 'agent x is blocked during startup and is not ready for prompts' }, id: 'cli:agent:start' }) + '\\n'); process.exit(1); }
  if (process.env.FAKE_AGENT_START === 'fail') { process.stderr.write(JSON.stringify({ error: { code: 'invalid_kind', message: 'unknown agent kind' }, id: 'cli:agent:start' }) + '\\n'); process.exit(1); }
  say({ result: { agent: { agent_status: 'idle' } } });
}
if (a[0] === 'agent' && a[1] === 'prompt') say('');
process.exit(97);
`, { mode: 0o755 });
  // ghq: root and list answer from the temporary tree; get is recorded and fails (no network).
  writeFileSync(join(bin, 'ghq'), `#!${process.execPath}
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghqLog)}, JSON.stringify(argv) + '\\n');
const root = ${JSON.stringify(ghq)};
if (argv[0] === 'root') { console.log(root); process.exit(0); }
if (argv[0] === 'list') {
  const host = join(root, 'github.com');
  for (const org of readdirSync(host)) for (const repo of readdirSync(join(host, org))) console.log(join(host, org, repo));
  process.exit(0);
}
process.exit(96);
`, { mode: 0o755 });
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const env = { PATH: `${bin}:${dirname(git)}`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: temporary };
  const repo = (org, name) => {
    const path = join(ghq, 'github.com', org, name);
    mkdirSync(path, { recursive: true });
    const g = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-C', path, ...args], { env, stdio: 'ignore' });
    g('init', '-q', '-b', 'main'); g('commit', '-q', '--allow-empty', '-m', 'init');
    return path;
  };
  const widget = repo('acme', 'widget');
  repo('acme', 'solo');
  const run = (args, extra = {}) => spawnSync(process.execPath, [entry, 'work', ...args], { cwd: temporary, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 });
  const reads = [['session', 'list', '--json'], ['--session', 'default', 'pane', 'list']];

  // A — a path, the repo root: one space, one agent; --dry runs only the two reads
  reset();
  let r = run([widget, '--dry']);
  eq(r.status, 0, `A exit: ${r.stderr}`);
  ok(r.stdout.includes(`workspace create --cwd ${widget} --label widget --no-focus`), `A plans the space: ${r.stdout}`);
  ok(r.stdout.includes('agent start widget --kind claude'), 'A plans the agent');
  eq(calls(herdrLog), reads, 'A --dry calls only session list and pane list');
  ok(!existsSync(join(widget, 'agents')), 'A --dry creates no worktree folder');

  // B — org/repo and a task: the dashboard's worktree, planned not made
  reset();
  r = run(['acme/widget', 'Fix', 'the', 'Login', '--dry']);
  eq(r.status, 0, `B exit: ${r.stderr}`);
  ok(r.stdout.includes(`worktree add ${join(widget, 'agents', 'fix-the-login')} -b agents/fix-the-login`), `B plans agents/<slug>: ${r.stdout}`);
  ok(r.stdout.includes('--label widget-fix-the-login'), 'B labels the space <repo>-<slug>');
  eq(calls(herdrLog), [reads[0]], 'B --dry with a new worktree reads only the session list');
  ok(!existsSync(join(widget, 'agents')), 'B --dry creates no worktree');

  // C — an issue URL names the task and is the first prompt
  reset();
  r = run(['https://github.com/acme/widget/issues/12', '--dry']);
  eq(r.status, 0, `C exit: ${r.stderr}`);
  ok(r.stdout.includes('agents/issue-12') && r.stdout.includes('agent prompt widget-issue-12 https://github.com/acme/widget/issues/12'), `C issue → slug + prompt: ${r.stdout}`);

  // D, E — not cloned: the clone is planned (https as given, -p for ssh), never run under --dry
  reset();
  r = run(['https://github.com/acme/ghost', '--dry']);
  eq(r.status, 0, `D exit: ${r.stderr}`);
  ok(r.stdout.includes('ghq get github.com/acme/ghost'), `D plans ghq get: ${r.stdout}`);
  ok(!calls(ghqLog).some(argv => argv[0] === 'get'), 'D --dry never runs ghq get');
  r = run(['git@github.com:acme/ghost.git', '--dry']);
  ok(r.status === 0 && r.stdout.includes('ghq get -p github.com/acme/ghost'), `E ssh URL clones with -p: ${r.stdout}${r.stderr}`);

  // F — a space already on that folder is reused, never doubled
  reset();
  const panes = JSON.stringify([{ pane_id: 'wT:p9', cwd: widget, agent: 'claude' }]);
  r = run([widget, '--dry'], { FAKE_PANES: panes });
  ok(r.status === 0 && r.stdout.includes('# already open: wT:p9'), `F --dry shows the open pane: ${r.stdout}`);
  reset();
  r = run([widget], { FAKE_PANES: panes });
  ok(r.status === 0 && r.stdout.includes('nothing started'), `F reuses: ${r.stdout}${r.stderr}`);
  ok(!calls(herdrLog).some(argv => argv.includes('workspace') || argv.includes('agent')), 'F starts nothing');

  reset();
  const shellOnly = JSON.stringify([{ pane_id: 'wT:p7', cwd: widget, agent: null }]);
  r = run([widget, '--dry'], { FAKE_PANES: shellOnly });
  ok(r.status === 0 && !r.stdout.includes('already open') && r.stdout.includes('--pane wT:p7'), `F2 --dry plans the agent in the shell pane: ${r.stdout}`);
  reset();
  r = run([widget], { FAKE_PANES: shellOnly });
  ok(r.status === 0 && r.stdout.includes('pane wT:p7'), `F2 starts the agent in the shell pane: ${r.stdout}${r.stderr}`);
  ok(!calls(herdrLog).some(argv => argv.includes('workspace')), 'F2 makes no new space');
  ok(calls(herdrLog).some(argv => argv.includes('start') && argv.includes('wT:p7')), 'F2 starts the agent in wT:p7');

  // G — for real against the fake herdr: the worktree is made by git, then space and agent
  reset();
  r = run(['acme/widget', 'my', 'task']);
  eq(r.status, 0, `G exit: ${r.stderr}`);
  const wt = join(widget, 'agents', 'my-task');
  ok(existsSync(join(wt, '.git')), 'G git worktree add made agents/my-task');
  eq(execFileSync('git', ['-C', wt, 'branch', '--show-current'], { env, encoding: 'utf8' }).trim(), 'agents/my-task', 'G branch agents/my-task');
  const made = calls(herdrLog);
  ok(made.some(argv => argv.join(' ') === `--session default workspace create --cwd ${wt} --label widget-my-task --no-focus`), `G workspace create argv: ${JSON.stringify(made)}`);
  ok(made.some(argv => argv.join(' ') === '--session default agent start widget-my-task --kind claude --pane wT:p1'), 'G agent start argv');
  ok(r.stdout.includes('bring it up: maw herdr a widget-my-task'), 'G ends with the command that brings it up');
  // the same task again reuses the worktree instead of numbering a second one
  reset();
  r = run(['acme/widget', 'my', 'task', '--dry']);
  ok(r.status === 0 && r.stdout.includes(`# reuse worktree ${wt}`), `G2 reuses the worktree: ${r.stdout}${r.stderr}`);

  // H — --prompt and --engine override; I — a clone that fails says how to clone instead
  reset();
  r = run(['https://github.com/acme/solo/pull/7', '--prompt', 'review it', '-e', 'codex']);
  eq(r.status, 0, `H exit: ${r.stderr}`);
  ok(calls(herdrLog).some(argv => argv.join(' ') === '--session default agent prompt solo-pr-7 review it'), 'H --prompt replaces the URL');
  ok(calls(herdrLog).some(argv => argv.includes('--kind') && argv.includes('codex')), 'H -e codex');
  reset();
  r = run(['https://github.com/acme/ghost']);
  ok(r.status === 1 && r.stderr.includes('gh repo clone acme/ghost'), `I clone failure ends with a fix: ${r.stderr}`);

  // J — a bare name: unique resolves, shared lists the choices, unknown says how to name it
  repo('beta', 'widget');
  r = run(['solo', '--dry']);
  ok(r.status === 0 && r.stdout.includes('solo →'), `J unique bare name resolves: ${r.stderr}`);
  r = run(['widget', '--dry']);
  ok(r.status === 1 && r.stderr.includes('acme/widget') && r.stderr.includes('beta/widget'), `J ambiguous lists both: ${r.stderr}`);
  r = run(['nosuch', '--dry']);
  ok(r.status === 1 && r.stderr.includes('maw herdr work <org>/nosuch'), `J unknown ends with a fix: ${r.stderr}`);

  // K — usage mistakes exit 2 with a fix line; L — no running session exits 1
  for (const [args, needle] of [[[], 'work needs a repo'], [['acme/widget', 'a task', '--wt', 'x'], 'not both'],
    [['acme/widget', '--engine'], '--engine needs a value'], [['https://gitlab.com/x/y'], 'not a path'], [['acme/solo', '--wt', '--dry'], '--wt needs a slug'], [['acme/solo', '--bogus'], 'unknown argument']]) {
    r = run(args);
    ok(r.status === 2 && r.stderr.includes(needle) && r.stderr.trim().split('\n').length >= 2, `K ${JSON.stringify(args)} → 2 with a fix line: ${r.status} ${r.stderr}`);
  }
  r = run(['acme/solo', '--dry'], { FAKE_NO_SESSION: '1' });
  ok(r.status === 1 && r.stderr.includes('no herdr session is running'), `L no session: ${r.stderr}`);

  // M — an agent waiting at a startup question (folder trust) is reported, never answered; exit 0
  reset();
  r = run(['acme/solo'], { FAKE_AGENT_START: 'blocked' });
  eq(r.status, 0, `M exit: ${r.stderr}`);
  ok(r.stdout.includes('waiting at a startup question') && r.stdout.includes('maw herdr a wT:p1'), `M says where to answer: ${r.stdout}`);
  ok(!calls(herdrLog).some(argv => argv.includes('prompt')), 'M sends nothing to a waiting agent');
  reset();
  r = run(['https://github.com/acme/solo/issues/3'], { FAKE_AGENT_START: 'blocked' });
  ok(r.status === 0 && r.stdout.includes('prompt held back') && r.stdout.includes('maw herdr hey wT:p1 https://github.com/acme/solo/issues/3'), `M2 holds the prompt back: ${r.stdout}${r.stderr}`);
  ok(!calls(herdrLog).some(argv => argv.includes('prompt')), 'M2 the prompt is not sent');
  // N — any other refusal is still a failure, with the start command to retry
  r = run(['acme/solo', '--wt', 'other'], { FAKE_AGENT_START: 'fail' });
  ok(r.status === 1 && r.stderr.includes('without a ready agent') && r.stderr.includes('agent start'), `N other errors fail: ${r.stderr}`);

  // O — the agent starts with the args of maw's commands.default, as maw-rs `maw work` does;
  //     `a || b` keeps its meaning: --continue only when the folder has a transcript to continue
  const solo = join(ghq, 'github.com', 'acme', 'solo');
  const mawDir = join(home, '.config', 'maw');
  mkdirSync(mawDir, { recursive: true });
  writeFileSync(join(mawDir, 'maw.config.50.json'), JSON.stringify({ commands: { default: 'claude --dangerously-skip-permissions --continue || claude --dangerously-skip-permissions' } }));
  const startOf = () => calls(herdrLog).find(argv => argv.includes('start'))?.join(' ');
  reset();
  r = run(['acme/solo']);
  eq(r.status, 0, `O1 exit: ${r.stderr}`);
  eq(startOf(), '--session default agent start solo --kind claude --pane wT:p1 -- --dangerously-skip-permissions', 'O1 no transcript: the fallback args, no --continue');
  const transcripts = join(home, '.claude', 'projects', solo.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(transcripts, '0b6c2c1e-9a4f-4d55-8d0e-2f1f3c4a5b6c.jsonl'), '{"type":"user"}\n'.repeat(100));
  reset();
  r = run(['acme/solo']);
  eq(startOf(), '--session default agent start solo --kind claude --pane wT:p1 -- --dangerously-skip-permissions --continue', `O2 a transcript: --continue: ${r.stderr}`);
  reset();
  r = run(['acme/solo', '--dry']);
  ok(r.stdout.includes('agent start solo --kind claude --pane \'<root pane>\' -- --dangerously-skip-permissions --continue'), `O3 --dry plans the args: ${r.stdout}`);
  reset();
  r = run(['acme/solo', '-e', 'codex']);
  eq(startOf(), '--session default agent start solo --kind codex --pane wT:p1', 'O4 a claude command gives no args to codex');
  rmSync(mawDir, { recursive: true, force: true });

  mkdirSync(join(temporary, 'herdr'));
  const sock = join(temporary, 'herdr', 'herdr.sock'), focusCalls = [];
  let refuseFocus = false;
  const server = createServer(c => c.on('data', d => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      const msg = JSON.parse(line); focusCalls.push([msg.method, msg.params]);
      c.write(JSON.stringify(refuseFocus ? { id: msg.id, error: { code: 'pane_not_found', message: 'no such pane' } } : { id: msg.id, result: {} }) + '\n');
    }
  }));
  await new Promise(done => server.listen(sock, done));
  const runAsync = (args, extra) => new Promise(done => {
    const child = spawn(process.execPath, [entry, 'work', ...args], { cwd: temporary, env: { ...env, FAKE_SOCKET: sock, ...extra } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => done({ status, stdout, stderr }));
  });
  const inside = { HERDR_PANE_ID: 'wA:p1', HERDR_SOCKET_PATH: sock };
  reset(); focusCalls.length = 0;
  r = await runAsync(['acme/solo', '--wt', 'front'], inside);
  eq(r.status, 0, `P1 exit: ${r.stderr}`);
  eq(focusCalls, [['pane.focus', { pane_id: 'wT:p1' }]], `P1 the new agent's pane is focused: ${r.stdout}`);
  ok(r.stdout.includes('focused solo-front (wT:p1)') && !r.stdout.includes('bring it up'), `P1 says it is in front: ${r.stdout}`);
  reset(); focusCalls.length = 0;
  r = await runAsync([widget], { ...inside, FAKE_PANES: JSON.stringify([{ pane_id: 'wT:p9', cwd: widget, agent: 'claude' }]) });
  eq(focusCalls, [['pane.focus', { pane_id: 'wT:p9' }]], `P2 an open space is focused, not doubled: ${r.stdout}${r.stderr}`);
  ok(!calls(herdrLog).some(argv => argv.includes('workspace') || argv.includes('agent')), 'P2 starts nothing');
  reset(); focusCalls.length = 0;
  r = await runAsync(['acme/solo', '--wt', 'trust'], { ...inside, FAKE_AGENT_START: 'blocked' });
  eq(focusCalls, [['pane.focus', { pane_id: 'wT:p1' }]], `P3 an agent at its trust question is put in front to answer: ${r.stdout}`);
  reset(); focusCalls.length = 0;
  r = await runAsync(['acme/solo', '--wt', 'away'], {});
  eq(focusCalls, [], 'P4 outside herdr nothing is focused');
  ok(r.stdout.includes('bring it up: maw herdr a solo-away'), `P4 outside herdr it says how to bring it up: ${r.stdout}`);
  reset(); focusCalls.length = 0;
  r = await runAsync(['acme/solo', '--wt', 'plan', '--dry'], inside);
  eq(focusCalls, [], 'P5 --dry focuses nothing');
  ok(r.stdout.includes('# focus the root pane in this herdr session'), `P5 --dry plans the focus: ${r.stdout}`);
  reset(); focusCalls.length = 0; refuseFocus = true;
  r = await runAsync(['acme/solo', '--wt', 'refused'], inside);
  eq(r.status, 0, `P6 a refused focus does not fail the work that is done: ${r.stderr}`);
  ok(r.stdout.includes('no such pane') && r.stdout.includes('maw herdr a wT:p1'), `P6 says why and how to bring it up: ${r.stdout}`);
  server.close();

  console.log(`ok: maw herdr work — ${checks} checks (${entry === join(root, 'index.mjs') ? 'source' : 'bundle'})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
