import { decodePayload, payloadFromHash } from './codec';
import { openImport, openImportError } from './open';

/**
 * Watch the address bar for a share link (`#tg-import=...`, on load and on `hashchange`) and
 * open the import dialog for it. Nothing is imported without the user's confirmation there;
 * the fragment is removed when the dialog closes (`closeShare`).
 */
export function installShareLinkHandler(): () => void {
  let latest = 0;
  const check = () => {
    const encoded = payloadFromHash(location.hash);
    if (encoded === null) return;
    const mine = ++latest;
    decodePayload(encoded).then(
      (payload) => {
        if (mine === latest) openImport(payload, 'link');
      },
      (error: unknown) => {
        if (mine === latest) openImportError(error, 'link');
      },
    );
  };
  check();
  window.addEventListener('hashchange', check);
  return () => {
    latest++;
    window.removeEventListener('hashchange', check);
  };
}
