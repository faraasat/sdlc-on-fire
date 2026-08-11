/**
 * Command normalisation before classification (P2-SEC-07, ADR-0036).
 *
 * P2-SEC-02 shipped a literal matcher and said plainly what it could not do:
 * it reads command text, and text can be obfuscated. This is that gap.
 *
 * **The honest framing, which shapes the whole design.** Fully deobfuscating a
 * shell command is not achievable — the shell is a programming language, and
 * deciding what an arbitrary program will execute is the halting problem
 * wearing a `$`. Anything claiming to normalise every command is either wrong
 * or lying.
 *
 * So this does two things instead of one:
 *
 * 1. **Unwrap the mechanical encodings** — base64 pipelines, `$IFS`, quote
 *    splitting, backslash escapes, `\x41`-style literals, simple variable
 *    indirection — and hand the result to the existing rules.
 * 2. **Treat leftover obfuscation as a finding in its own right.** A command
 *    that base64-decodes into a shell is suspicious *because it does that*,
 *    regardless of what the payload turns out to be. This is what makes the
 *    undecidability tolerable: we do not have to know what the command does in
 *    order to know that nobody writes it that way by accident.
 *
 * The second point is the load-bearing one. An adversary who defeats the
 * unwrapping still trips the "this is deliberately unreadable" rule, and an
 * agent following an ordinary plan trips neither.
 */

export interface NormalizedCommand {
  /** The command with mechanical encodings resolved as far as they resolve. */
  readonly text: string;
  /** Obfuscation techniques observed, whether or not they were undone. */
  readonly techniques: readonly string[];
  /** True when a decoded payload was recovered and appended. */
  readonly decoded: boolean;
}

/** Bounded so a crafted input cannot spin here. */
const MAX_PASSES = 5;
const MAX_LENGTH = 64 * 1024;

/** `$IFS`, `${IFS}`, `$IFS$9` — a space written so it does not look like one. */
const IFS = /\$\{?IFS\}?(?:\$\d)?/g;

/** `"" `, `''`, and `\` inserted mid-word purely to break a literal match. */
const EMPTY_QUOTES = /(?<=\w)(?:""|'')(?=\w)/g;
const MID_WORD_ESCAPE = /(?<=\w)\\(?=\w)/g;

const HEX_ESCAPE = /\\x([0-9a-fA-F]{2})/g;
const UNICODE_ESCAPE = /\\u\{?([0-9a-fA-F]{4,6})\}?/g;

/** `echo <b64> | base64 -d | sh`, in its usual orderings. */
const BASE64_PAYLOAD =
  /(?:echo|printf)\s+(?:-[a-zA-Z]+\s+)*["']?([A-Za-z0-9+/=]{16,})["']?\s*\|\s*(?:base64\s+(?:-d|--decode|-D)|openssl\s+base64\s+-d)/;
const BASE64_INLINE = /base64\s+(?:-d|--decode|-D)\s*<<<\s*["']?([A-Za-z0-9+/=]{16,})["']?/;

/** `X=rm; $X -rf /` — an assignment whose value is later expanded. */
const ASSIGNMENT = /(?:^|[;&|]\s*)([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^\s;&|]*)\2/g;

/**
 * Whether decoded bytes read as text a shell could plausibly have been given.
 *
 * Checked by codepoint rather than by a regex: a character class containing
 * literal control characters is invisible in a diff and indistinguishable from
 * one that got there by accident — which is exactly why `no-control-regex`
 * exists. Tab, newline and carriage return are allowed through; they appear in
 * real scripts.
 */
function readsAsText(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f || code === 0xfffd) return false;
  }
  return true;
}

function decodeBase64(payload: string): string | null {
  try {
    const text = Buffer.from(payload, 'base64').toString('utf8');
    // A decode yielding control or replacement characters was not
    // base64-encoded text; reporting it as a command would invent one.
    if (text.length === 0 || !readsAsText(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Resolves what can be resolved, and records what was seen either way.
 *
 * Runs to a fixed point rather than once: obfuscation nests, and a single pass
 * over `$IFS`-separated base64 leaves the base64 unread.
 */
export function normalizeCommand(command: string): NormalizedCommand {
  const techniques = new Set<string>();
  let text = command.slice(0, MAX_LENGTH);
  let decoded = false;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = text;

    if (IFS.test(text)) {
      techniques.add('ifs-substitution');
      text = text.replaceAll(IFS, ' ');
    }
    if (HEX_ESCAPE.test(text)) {
      techniques.add('hex-escape');
      text = text.replaceAll(HEX_ESCAPE, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
    if (UNICODE_ESCAPE.test(text)) {
      techniques.add('unicode-escape');
      text = text.replaceAll(UNICODE_ESCAPE, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      );
    }
    // Escape *decoding* must precede escape *stripping*. `\x72\x6d` contains a
    // backslash sitting between two word characters, so the mid-word rule below
    // would otherwise eat it first and leave `rx6d` — a normaliser quietly
    // producing a different command than the one that will run.
    if (EMPTY_QUOTES.test(text)) {
      techniques.add('empty-quote-splitting');
      text = text.replaceAll(EMPTY_QUOTES, '');
    }
    if (MID_WORD_ESCAPE.test(text)) {
      techniques.add('mid-word-escape');
      text = text.replaceAll(MID_WORD_ESCAPE, '');
    }

    const base64 = BASE64_PAYLOAD.exec(text) ?? BASE64_INLINE.exec(text);
    if (base64?.[1] !== undefined) {
      techniques.add('base64-payload');
      const payload = decodeBase64(base64[1]);
      if (payload !== null) {
        decoded = true;
        // Appended rather than substituted: the pipeline that *runs* the
        // payload is itself evidence, and replacing it would discard the fact
        // that this was piped into a shell at all.
        text = `${text}\n${payload}`;
      }
    }

    // `X=rm; $X -rf /`. Only literal assignments, only within one command —
    // anything further is interpretation, and interpretation is where a
    // deterministic checker stops being deterministic.
    const assignments = [...text.matchAll(ASSIGNMENT)];
    if (assignments.length > 0) {
      let expanded = text;
      for (const [, name, , value] of assignments) {
        if (name === undefined || value === undefined || value === '') continue;
        const reference = new RegExp(`\\$\\{?${name}\\}?(?![A-Za-z0-9_])`, 'g');
        if (reference.test(expanded)) {
          techniques.add('variable-indirection');
          expanded = expanded.replaceAll(reference, value);
        }
      }
      text = expanded;
    }

    if (text === before) break;
  }

  // Collapse the whitespace the substitutions introduced, so `rm  -rf` matches
  // the same rules as `rm -rf`.
  text = text.replaceAll(/[^\S\n]+/g, ' ').trim();

  return { text, techniques: [...techniques].sort(), decoded };
}

/**
 * Whether the obfuscation is itself worth stopping for.
 *
 * Separate from what the command turns out to say. `echo <base64> | base64 -d |
 * sh` warrants a human even if the payload decodes to something harmless,
 * because the shape is not one anybody reaches for by accident — and if the
 * payload could not be decoded, the shape is all the evidence there is.
 */
export function isDeliberatelyObfuscated(normalized: NormalizedCommand): boolean {
  return normalized.techniques.length > 0;
}
