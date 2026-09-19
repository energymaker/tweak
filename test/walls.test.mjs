import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallFor } from '../lib/walls.js';

const Q = 'https://www.google.com/search?q=how+to+boil+an+egg';

test('a 429 response is a wall', () => {
  assert.deepEqual(wallFor({ requested: Q, final: Q, status: 429 }), { kind: 'blocked', reason: 'the page answered with HTTP 429 (too many requests)', finalUrl: Q });
  assert.equal(wallFor({ requested: Q, final: Q, status: 503 }).kind, 'blocked');
});

test('a redirect to another host is "moved", with where it ended up', () => {
  const w = wallFor({ requested: 'https://example.com/a', final: 'https://other.org/b', status: 200 });
  assert.deepEqual([w.kind, w.finalUrl], ['moved', 'https://other.org/b']);
});

test("Google's /sorry/ page is a wall, even when it answers 200", () => {
  const sorry = 'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Degg&q=abc';
  assert.equal(wallFor({ requested: Q, final: sorry, status: 200 }).kind, 'blocked');
  assert.match(wallFor({ requested: Q, final: sorry, status: 429 }).reason, /unusual traffic/);
});

test('consent.google.com is still a consent wall, as before', () => {
  const w = wallFor({ requested: 'https://www.youtube.com/', final: 'https://consent.youtube.com/m?continue=x', status: 200 });
  assert.deepEqual([w.kind, w.reason], ['consent', 'the site sent the test browser to its consent page']);
});

test('a sign-in page is a wall, unless it is what was asked for', () => {
  assert.equal(wallFor({ requested: 'https://github.com/torvalds/linux', final: 'https://github.com/login?return_to=x', status: 200 }).kind, 'blocked');
  assert.equal(wallFor({ requested: 'https://github.com/login', final: 'https://github.com/login', status: 200 }), null);
});

test('a consent dialog covering the page is a consent wall', () => {
  assert.equal(wallFor({ requested: Q, final: Q, status: 200, dialog: 'a cookie consent dialog covers the page' }).kind, 'consent');
});

test('a normal page is not a wall', () => {
  // Control for every case above: the same checks, on pages that are fine.
  assert.equal(wallFor({ requested: Q, final: Q + '&sei=abc', status: 200 }), null);
  assert.equal(wallFor({ requested: 'https://github.com/torvalds/linux', final: 'https://www.github.com/torvalds/linux', status: 200 }), null, 'www is the same site');
  assert.equal(wallFor({ requested: 'https://en.wikipedia.org/wiki/Minecraft', final: 'https://en.wikipedia.org/wiki/Minecraft', status: null }), null, 'an unknown status is not an error');
  assert.equal(wallFor({ requested: 'https://example.com/', final: 'https://example.com/sorry/', status: 200 }), null, '/sorry/ only counts on Google');
});
