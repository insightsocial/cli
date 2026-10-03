import { readFileSync } from 'node:fs';

/** Read once from package.json so the version has exactly one source. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const DEFAULT_BASE_URL = 'https://api.insightsocial.app';
export const API_KEY_ENV = 'INSIGHTSOCIAL_API_KEY';
export const BASE_URL_ENV = 'INSIGHTSOCIAL_BASE_URL';
export const HOME_ENV = 'INSIGHTSOCIAL_HOME';

export const KEYS_URL = 'https://www.insightsocial.app/portal/api/keys';
export const BILLING_URL = 'https://www.insightsocial.app/portal/billing';
export const DOCS_URL = 'https://www.insightsocial.app/docs';
export const SUPPORT_EMAIL = 'support@insightsocial.app';

/** Sent on every request so API traffic from this package can be told apart. */
export const CLIENT_HEADER = 'x-insightsocial-client';

/** The catalogue changes only on a deploy; the server itself caches it for an hour. */
export const CATALOGUE_TTL_MS = 60 * 60 * 1000;

export const PLATFORMS = [
  'instagram',
  'tiktok',
  'linkedin',
  'facebook',
  'youtube',
  'twitter',
  'reddit',
  'threads',
  'pinterest',
] as const;
