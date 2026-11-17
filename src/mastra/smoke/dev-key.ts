import { createHash } from 'node:crypto';

/**
 * Which Anthropic key the live smoke test may spend (exponential ticket 962).
 *
 * The smoke test makes real, billed model calls, so it only ever reads the
 * capped development key and refuses anything that could be the production
 * one. The production key lives in `ANTHROPIC_API_KEY`; the development key
 * has its own name, its own Anthropic workspace and a monthly spend limit.
 */

/** The only variable the smoke test reads a key from. */
export const DEV_KEY_ENV = 'ANTHROPIC_API_KEY_DEV';
/** The variable the deployed service reads. Never spent by the smoke test. */
export const PRODUCTION_KEY_ENV = 'ANTHROPIC_API_KEY';
/**
 * Optional, comma-separated SHA-256 hex digests of keys the smoke test must
 * never use (the production key, in practice). A digest is safe to store as a
 * plain repository variable; it catches the production key pasted under the
 * development name on a machine where `ANTHROPIC_API_KEY` is not set.
 */
export const FORBIDDEN_DIGESTS_ENV = 'ANTHROPIC_PRODUCTION_KEY_SHA256';

export class DevKeyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevKeyRefusal';
  }
}

export const keyDigest = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/** Signs that this process is the deployed service, not a laptop or CI. */
function productionEnvironment(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is "production"';
  const railway = env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT;
  if (railway) return `this is a Railway environment ("${railway}")`;
  return null;
}

/**
 * Returns the development key, or throws a DevKeyRefusal that says why not.
 * The message never contains any part of a key.
 */
export function resolveDevKey(env: NodeJS.ProcessEnv = process.env): string {
  const production = productionEnvironment(env);
  if (production) {
    throw new DevKeyRefusal(
      `Refusing to run: ${production}. The live smoke test runs on a laptop or in the eval workflow only.`,
    );
  }

  const devKey = env[DEV_KEY_ENV]?.trim();
  if (!devKey) {
    throw new DevKeyRefusal(
      `${DEV_KEY_ENV} is not set. The live smoke test spends real money, so it only uses the capped ` +
        `development key and never falls back to ${PRODUCTION_KEY_ENV}. Add ${DEV_KEY_ENV} to this ` +
        `checkout's .env (see README.md, "Running a real agent turn").`,
    );
  }

  const productionKey = env[PRODUCTION_KEY_ENV]?.trim();
  if (productionKey && productionKey === devKey) {
    throw new DevKeyRefusal(
      `Refusing to run: ${DEV_KEY_ENV} holds the same key as ${PRODUCTION_KEY_ENV}. ` +
        `The development key must be a separate key with its own spend limit.`,
    );
  }

  const forbidden = (env[FORBIDDEN_DIGESTS_ENV] ?? '')
    .split(',')
    .map((digest) => digest.trim().toLowerCase())
    .filter(Boolean);
  if (forbidden.includes(keyDigest(devKey))) {
    throw new DevKeyRefusal(
      `Refusing to run: ${DEV_KEY_ENV} matches a digest in ${FORBIDDEN_DIGESTS_ENV}, ` +
        `so it is the production key under the development name.`,
    );
  }

  return devKey;
}
