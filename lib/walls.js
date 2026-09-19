// Is the page we were given the page that was asked for? If not, nothing built
// on it can be trusted, so a run stops before the model sees it.
//
//   consent: a cookie or consent page or dialog. Accepting once fixes it.
//   blocked: an error status, a bot check or a sign-in page. Nothing to offer.
//   moved:   a real page, but on a different site. The app offers to use it.

// Pages that stand in front of the real one. Checked against host + path.
const INTERSTITIALS = [
  [/^consent\.(google|youtube)\.[a-z.]+\//, 'consent', 'the site sent the test browser to its consent page'],
  [/^(www\.)?google\.[a-z.]+\/sorry\//, 'blocked', "Google showed its unusual traffic check instead of the page"],
  [/^accounts\.google\.com\//, 'blocked', 'the site asked the test browser to sign in'],
  [/^(www\.)?github\.com\/(login|session)\b/, 'blocked', 'the site asked the test browser to sign in'],
  [/^login\.microsoftonline\.com\//, 'blocked', 'the site asked the test browser to sign in'],
  [/^(www\.)?(x|twitter)\.com\/i\/flow\/login\b/, 'blocked', 'the site asked the test browser to sign in'],
  [/^(www\.)?(facebook|instagram)\.com\/(login|accounts\/login)\b/, 'blocked', 'the site asked the test browser to sign in'],
  [/\/cdn-cgi\/challenge-platform\//, 'blocked', 'the site showed a bot check instead of the page']
];

const where = u => { try { const x = new URL(u); return (x.hostname + x.pathname).toLowerCase(); } catch { return ''; } };
export const sameSite = (a, b) => { try { const h = u => new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return h(a) === h(b); } catch { return false; } };

function interstitial(url) {
  const w = where(url);
  const hit = INTERSTITIALS.find(([re]) => re.test(w));
  return hit ? { kind: hit[1], reason: hit[2] } : null;
}

// requested: the address asked for. final: where the browser ended up.
// status: the HTTP status of the page's main document, or null if unknown.
// dialog: the reason a consent dialog covers the page, or ''.
export function wallFor({ requested, final, status = null, dialog = '' }) {
  // Asking for a sign-in page on purpose is not a wall.
  const asked = interstitial(requested);
  const got = interstitial(final);
  if (got && !(asked && where(requested) === where(final))) return { ...got, finalUrl: final };
  if (status >= 400) return { kind: 'blocked', reason: `the page answered with HTTP ${status}${status === 429 ? ' (too many requests)' : ''}`, finalUrl: final };
  if (!sameSite(requested, final)) return { kind: 'moved', reason: `the page moved to ${new URL(final).hostname}`, finalUrl: final };
  if (dialog) return { kind: 'consent', reason: dialog, finalUrl: final };
  return null;
}
