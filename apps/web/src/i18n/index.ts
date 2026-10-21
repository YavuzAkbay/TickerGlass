/**
 * Dependency-free i18n: `t(key, params?)` looks a message up in the active
 * locale's catalog, falls back to English, and fills `{name}` placeholders.
 * The locale lives in the ui store (`useUiStore.locale`). To add a locale see
 * docs/i18n.md.
 */
import { useCallback } from 'react';
import { useUiStore } from '../store/ui';
import { en, type Catalog, type MessageKey } from './en';

export type { Catalog, MessageKey };

export const DEFAULT_LOCALE = 'en';
/** Locales with a catalog. `en` is complete; others may be partial (missing keys use English). */
export type Locale = 'en';

export const CATALOGS: Record<Locale, Partial<Catalog>> = { en };

export type MessageParams = Record<string, string | number>;

export const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && Object.hasOwn(CATALOGS, v);

/** Translate `key` for `locale` (English when missing); unknown placeholders stay as written. */
export function translate(locale: string, key: MessageKey, params?: MessageParams): string {
  const catalog = isLocale(locale) ? CATALOGS[locale] : undefined;
  const message = catalog?.[key] ?? en[key];
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** Translate with the current locale (outside React; does not re-render on locale change). */
export const t = (key: MessageKey, params?: MessageParams): string =>
  translate(useUiStore.getState().locale, key, params);

/** `t` bound to the current locale; components re-render when the locale changes. */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const locale = useUiStore((s) => s.locale);
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}
