/** Thrown for user mistakes (unknown flag, missing value) so main() can exit 2. */
export class UsageError extends Error {}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface FlagSpec {
  /** Flags that take no value. */
  boolean?: string[];
  /** Flags that require a value. */
  value?: string[];
}

/**
 * Tiny, strict flag parser. Unknown flags are an error rather than being
 * silently ignored, because a typo'd secret or host must never be dropped on
 * the floor. Supports --flag, --flag=value, --flag value, --, and -f value.
 */
export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const boolean = new Set(spec.boolean ?? []);
  const value = new Set(spec.value ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  const assign = (name: string, inline?: string) => {
    if (!boolean.has(name) && !value.has(name)) throw new UsageError(`unknown flag ${name.length === 1 ? "-" : "--"}${name}`);
    if (boolean.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      flags[name] = true;
      return true;
    }
    if (inline !== undefined) {
      flags[name] = inline;
      return false;
    }
    return undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!name) throw new UsageError("empty flag");
      const consumed = assign(name, eq === -1 ? undefined : arg.slice(eq + 1));
      if (consumed === false) continue;
      if (consumed === true) continue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) throw new UsageError(`--${name} requires a value`);
      flags[name] = next;
      i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const name = arg.slice(1);
      const consumed = assign(name);
      if (consumed === true) continue;
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`-${name} requires a value`);
      flags[name] = next;
      i++;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

/** Required positional with a helpful message instead of an undefined crash. */
export function requiredArg(positionals: string[], index: number, what: string, usage: string): string {
  const v = positionals[index];
  if (v === undefined || v === "") throw new UsageError(`missing ${what}\n\nusage: ${usage}`);
  return v;
}