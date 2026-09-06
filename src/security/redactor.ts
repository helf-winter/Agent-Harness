export const REDACTION_RULES_VERSION = "1.0.0";
const REDACTED = "<REDACTED>";

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)/i;
type InlineReplacement = string | ((substring: string) => string);
const INLINE_RULES: ReadonlyArray<readonly [RegExp, InlineReplacement]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <REDACTED>"],
  [/\bsk-ant-[A-Za-z0-9_-]+\b/g, REDACTED],
  [
    /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)\s*=\s*[^\s]+/gi,
    (match: string) => `${match.split("=")[0]}=${REDACTED}`,
  ],
];

export interface RedactionResult<T> {
  value: T;
  redactedFields: string[];
}

export interface RedactionOptions {
  userHome?: string;
}

export function redact<T>(input: T, options: RedactionOptions = {}): RedactionResult<T> {
  const redactedFields = new Set<string>();

  function visit(value: unknown, path: string): unknown {
    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, `${path}[${index}]`));
    }

    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          const childPath = path ? `${path}.${key}` : key;
          if (SENSITIVE_KEY.test(key)) {
            redactedFields.add(childPath);
            return [key, REDACTED];
          }
          return [key, visit(child, childPath)];
        }),
      );
    }

    if (typeof value !== "string") {
      return value;
    }

    let output = value;
    if (options.userHome) {
      const escaped = escapeRegExp(options.userHome).replace(/[/\\\\]+/g, "[/\\\\]+");
      const next = output.replace(new RegExp(escaped, "gi"), "<USER_HOME>");
      if (next !== output) {
        redactedFields.add(path);
        output = next;
      }
    }

    for (const [pattern, replacement] of INLINE_RULES) {
      const next =
        typeof replacement === "string"
          ? output.replace(pattern, replacement)
          : output.replace(pattern, replacement);
      if (next !== output) {
        redactedFields.add(path);
        output = next;
      }
    }

    return output;
  }

  return {
    value: visit(input, "") as T,
    redactedFields: [...redactedFields].sort(),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
