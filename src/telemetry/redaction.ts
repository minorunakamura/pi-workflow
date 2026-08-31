const REDACTED_SECRET = "[REDACTED_SECRET]";
const SECRET_FIELD =
  "(?:api[-_ ]?key|access[-_ ]?key|client[-_ ]?secret|secret(?:[-_ ]?(?:access[-_ ]?key|key|token|value))?|password|passwd|token|authorization)";
const AUTHORIZATION_VALUE = new RegExp(
  String.raw`((?:^|[^A-Za-z0-9])(?:proxy-)?authorization\b\s*:\s*(?:bearer|basic)\s+)[^\s,]+`,
  "gi",
);
const QUOTED_SECRET = new RegExp(
  String.raw`((?:^|[^A-Za-z0-9])${SECRET_FIELD}\b\s*[:=]\s*)(["'])([\s\S]*?)\2`,
  "gi",
);
const UNQUOTED_SECRET = new RegExp(
  String.raw`((?:^|[^A-Za-z0-9])${SECRET_FIELD}\b\s*[:=]\s*)(?!["'\[])[^\s,;\]}"']+`,
  "gi",
);
const TOKEN_VALUE =
  /\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;

export function redactSecrets(contents: string): string {
  return contents
    .replace(AUTHORIZATION_VALUE, (_match: string, prefix: string) => `${prefix}${REDACTED_SECRET}`)
    .replace(
      QUOTED_SECRET,
      (_match: string, prefix: string, quote: string) =>
        `${prefix}${quote}${REDACTED_SECRET}${quote}`,
    )
    .replace(UNQUOTED_SECRET, (_match: string, prefix: string) => `${prefix}${REDACTED_SECRET}`)
    .replace(TOKEN_VALUE, REDACTED_SECRET);
}
