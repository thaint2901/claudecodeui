// @ts-check
/**
 * Fork-owned i18n namespace registration (CLAUDE.md Fork Maintenance Rule 2;
 * recorded as Decision item 3 in docs/adr/ADR-0001-fork-customization-strategy.md).
 *
 * All fork-feature translation keys live in fork.json per locale, never in
 * upstream's chat.json/settings.json. This module is the single registration
 * point so upstream-owned config.js only carries a 2-line call site.
 * The `fr` locale exists on disk but is not registered in config.js, so it
 * is not registered here either.
 */
import deFork from './locales/de/fork.json';
import enFork from './locales/en/fork.json';
import itFork from './locales/it/fork.json';
import jaFork from './locales/ja/fork.json';
import koFork from './locales/ko/fork.json';
import ruFork from './locales/ru/fork.json';
import trFork from './locales/tr/fork.json';
import zhCNFork from './locales/zh-CN/fork.json';
import zhTWFork from './locales/zh-TW/fork.json';

export const FORK_NAMESPACE = 'fork';

const forkResources = {
  de: deFork,
  en: enFork,
  it: itFork,
  ja: jaFork,
  ko: koFork,
  ru: ruFork,
  tr: trFork,
  'zh-CN': zhCNFork,
  'zh-TW': zhTWFork,
};

/**
 * Registers the fork namespace on an initialized i18next instance.
 * addResourceBundle marks the namespace as loaded, so useTranslation(['chat', 'fork'])
 * resolves synchronously with the static-resources setup config.js uses.
 * @param {import('i18next').i18n} i18nInstance - an initialized i18next instance
 */
export function registerForkNamespace(i18nInstance) {
  for (const [lng, bundle] of Object.entries(forkResources)) {
    i18nInstance.addResourceBundle(lng, FORK_NAMESPACE, bundle, true, false);
  }
}
