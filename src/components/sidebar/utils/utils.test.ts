import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCompactSessionAge } from './utils';

const NOW = new Date('2026-07-25T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('an unparseable timestamp renders nothing rather than NaN', () => {
  // The sidebar row prints this straight into its right-hand column, so a
  // bad value has to come back empty, not as "NaNm".
  assert.equal(formatCompactSessionAge('not a date', NOW), '');
  assert.equal(formatCompactSessionAge('', NOW), '');
});

test('a future timestamp is clamped instead of going negative', () => {
  // Clock skew between the watcher and the app has produced these before.
  assert.equal(formatCompactSessionAge(ago(-5 * MINUTE), NOW), '<1m');
});

test('under a minute reads as <1m', () => {
  assert.equal(formatCompactSessionAge(ago(59 * 1000), NOW), '<1m');
});

test('minutes are shown up to the hour boundary', () => {
  assert.equal(formatCompactSessionAge(ago(MINUTE), NOW), '1m');
  assert.equal(formatCompactSessionAge(ago(59 * MINUTE), NOW), '59m');
});

test('the 60-minute boundary flips to hours', () => {
  assert.equal(formatCompactSessionAge(ago(HOUR), NOW), '1hr');
  assert.equal(formatCompactSessionAge(ago(23 * HOUR), NOW), '23hr');
});

test('the 24-hour boundary flips to days', () => {
  assert.equal(formatCompactSessionAge(ago(DAY), NOW), '1d');
  assert.equal(formatCompactSessionAge(ago(9 * DAY), NOW), '9d');
});

test('SQLite timestamps normalized to ISO with Z are read as UTC', () => {
  // getClusterBranches/normalizeSessionRows rewrite `2026-07-25 09:00:00` to
  // ISO-with-Z before this ever sees it; parsing the normalized form must not
  // pick up the local offset.
  assert.equal(formatCompactSessionAge('2026-07-25T09:00:00.000Z', NOW), '3hr');
});
