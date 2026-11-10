import { herdrJson } from './mod.syncCall.mjs';

/** A pane's foreground process group, shell pid and the id herdr reports for it (an old id after a move is an alias), or null when herdr says neither. */
export function paneProcess(pane, session) {
  const info = herdrJson(['pane', 'process-info', '--pane', pane], session)?.result?.process_info;
  const fg = info?.foreground_process_group_id;
  const shell = info?.shell_pid;
  return Number.isInteger(fg) || Number.isInteger(shell) ? { fg, shell, pane: info?.pane_id ?? pane } : null;
}
