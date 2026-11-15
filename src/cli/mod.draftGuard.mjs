import { visibleText } from '../serve/bun/mod.parseComposer.ts';

export const DRAFT_POLL_MS = 5_000;
export const DRAFT_WAIT_MS = 120_000;

const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

export const draftLimits = (env = process.env) => ({
  pollMs: positive(env.MAW_HERDR_DRAFT_POLL_MS, DRAFT_POLL_MS),
  waitMs: positive(env.MAW_HERDR_DRAFT_WAIT_MS, DRAFT_WAIT_MS),
});

export function inputRowState(ansi) {
  const rows = visibleText(ansi).split('\n').filter(row => row.startsWith('❯'));
  if (!rows.length) return 'none';
  return rows[rows.length - 1].slice('❯'.length).trim() ? 'draft' : 'empty';
}

const nap = ms => new Promise(done => setTimeout(done, ms));

export async function waitForEmptyInput({ read, sleep = nap, pollMs = DRAFT_POLL_MS, waitMs = DRAFT_WAIT_MS }) {
  for (let waited = 0; ; waited += pollMs) {
    if (inputRowState(read()) !== 'draft') return 'send';
    if (waited >= waitMs) return 'draft';
    await sleep(pollMs);
  }
}
