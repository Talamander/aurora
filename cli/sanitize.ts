// Untrusted text (posts, articles, agent replies quoting them) must never reach the terminal raw.
// A post can carry escape sequences that retitle the window, rewrite the clipboard (OSC 52),
// smuggle hyperlinks (OSC 8), move the cursor to fake UI, or reorder text with bidi controls.
// Everything printable survives; everything that could steer the terminal is dropped.

// ESC-introduced sequences: CSI (ESC [ ... final), OSC / DCS / SOS / PM / APC (terminated by BEL
// or ST), and the short two-byte forms (ESC 7, ESC c, ESC ( B ...). An unterminated string
// loses only its introducer, so the rest of the post stays readable and inert.
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]?|[\]PX^_][\s\S]{0,8192}?(?:\x07|\x1b\\)|[ -/]*[0-~]?)/g;
// 8-bit C1 equivalents: CSI (0x9b), OSC (0x9d), DCS (0x90), SOS (0x98), PM (0x9e), APC (0x9f).
const C1_SEQ = /\x9b[0-?]*[ -/]*[@-~]?|[\x90\x98\x9d\x9e\x9f][\s\S]{0,8192}?(?:\x07|\x9c|\x1b\\)/g;
// Remaining C0 controls except tab and newline, DEL, and every C1 control.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
// Bidi embeddings, overrides and isolates, which can make text display in a different order
// from what it says, plus the line and paragraph separators that some terminals treat as newlines.
const BIDI = /[\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** Strip every terminal control from untrusted text. Newlines and tabs are kept. */
export function sanitize(text: unknown): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(ESC_SEQ, '')
    .replace(C1_SEQ, '')
    .replace(CONTROLS, '')
    .replace(BIDI, '');
}

/** Sanitize and fold to one line, for list rows and titles. */
export function oneLine(text: unknown): string {
  return sanitize(text).replace(/\s+/g, ' ').trim();
}
