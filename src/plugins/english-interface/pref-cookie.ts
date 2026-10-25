import type { Session } from 'electron';

// YouTube picks the interface language from `hl` in its PREF cookie, and
// without one falls back to the account's region (which turned the interface
// Turkish here even though the browser language is en-US). Pin `hl=en` in that
// cookie, keeping YouTube's other PREF keys (repeat, volume, autoplay...).

const INTERFACE_LANGUAGE = 'en';
const PREF_URL = 'https://music.youtube.com';
const PREF_DOMAIN = '.youtube.com';
const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;

const withLanguage = (value: string) => {
  const pref = new URLSearchParams(value);
  if (pref.get('hl') === INTERFACE_LANGUAGE) return null;
  pref.set('hl', INTERFACE_LANGUAGE);
  return pref.toString();
};

const writePref = (session: Session, value: string) =>
  session.cookies.set({
    url: PREF_URL,
    name: 'PREF',
    value,
    domain: PREF_DOMAIN,
    path: '/',
    secure: true,
    expirationDate: Math.floor(Date.now() / 1000) + TWO_YEARS_SECONDS,
  });

let watching = false;

export const forceEnglishInterface = async (session: Session) => {
  const [existing] = await session.cookies.get({
    url: PREF_URL,
    name: 'PREF',
  });
  const value = withLanguage(existing?.value ?? '');
  if (value !== null) await writePref(session, value);

  if (watching) return;
  watching = true;

  // YouTube rewrites PREF whenever a preference changes (and the language
  // picker in its settings would set `hl` too), so put `hl=en` back each time.
  session.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed || cookie.name !== 'PREF') return;
    if (!cookie.domain?.endsWith('youtube.com')) return;
    const fixed = withLanguage(cookie.value);
    if (fixed !== null) void writePref(session, fixed);
  });
};
