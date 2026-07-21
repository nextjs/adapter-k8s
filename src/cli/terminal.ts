// src/cli/terminal.ts

// L14: cluster-sourced strings (pod logs, condition messages, error snippets) can
// carry terminal control sequences (ESC, CSI introducers) that rewrite the operator's
// terminal, forge output, or hide earlier warnings. Strip C0/C1 control characters
// before printing; keep \n and \t, which are legitimate log formatting.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

export function sanitizeForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS_RE, "");
}
