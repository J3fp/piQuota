/**
 * Argument parsing shared by both CLIs.
 *
 * Deliberately small: this parser only owns the flags piquota itself
 * implements, and reports anything else as unknown.
 */

/**
 * @typedef {Object} ParsedArgs
 * @property {string[]} positionals
 * @property {boolean} json
 * @property {boolean} compact
 * @property {boolean} color
 * @property {boolean} noPi
 * @property {boolean} noCache
 * @property {boolean} force
 * @property {boolean} explain
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} showEmail
 * @property {boolean} status
 * @property {boolean} clearCache
 * @property {number} ttlMs
 * @property {number} timeoutMs
 * @property {string[]} unknown          Flags this parser does not own.
 * @property {string[]} raw              Original argv.
 */

const VALUE_FLAGS = new Set(["--ttl", "--timeout"]);

/**
 * @param {string[]} argv
 * @param {{ defaultTtlMs?: number, defaultTimeoutMs?: number }} [defaults]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, defaults = {}) {
  /** @type {ParsedArgs} */
  const parsed = {
    positionals: [],
    json: false,
    compact: false,
    color: true,
    noPi: false,
    noCache: false,
    force: false,
    explain: false,
    help: false,
    version: false,
    showEmail: false,
    status: false,
    clearCache: false,
    ttlMs: defaults.defaultTtlMs ?? 60_000,
    timeoutMs: defaults.defaultTimeoutMs ?? 15_000,
    unknown: [],
    raw: [...argv],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      index += 1;
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        parsed.unknown.push(arg, value ?? "");
        continue;
      }
      if (arg === "--ttl") parsed.ttlMs = number * 1000;
      if (arg === "--timeout") parsed.timeoutMs = number;
      continue;
    }

    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--compact":
      case "-c":
        parsed.compact = true;
        break;
      case "--no-color":
        parsed.color = false;
        break;
      case "--no-pi":
        parsed.noPi = true;
        break;
      case "--no-cache":
        parsed.noCache = true;
        break;
      case "--force":
      case "--refresh":
        parsed.force = true;
        break;
      case "--explain":
        parsed.explain = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--show-email":
        parsed.showEmail = true;
        break;
      case "--status":
        parsed.status = true;
        break;
      case "--clear-cache":
        parsed.clearCache = true;
        break;
      default:
        if (arg.startsWith("-")) parsed.unknown.push(arg);
        else parsed.positionals.push(arg);
    }
  }

  return parsed;
}
