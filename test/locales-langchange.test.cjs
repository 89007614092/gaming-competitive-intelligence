'use strict';
// Verifies that setLang() broadcasts a `langchange` CustomEvent so the app's
// data-driven views (KB, News, Patents, Risks, …) can re-render in the chosen
// language WITHOUT a page refresh (PR #99). See public/locales.js setLang().
const { test } = require('node:test');
const assert = require('node:assert');

// Stub a minimal window that captures dispatched events. Defined before the
// require so the IIFE binds `root` to this stub and setLang() can dispatch.
let lastEvent = null;
let dispatchCount = 0;
global.window = {
  addEventListener() { /* no-op: we only need to observe dispatches */ },
  dispatchEvent(ev) { dispatchCount += 1; lastEvent = ev; return true; },
};

const { setLang, getLang } = require('../public/locales.js');

test('setLang(zh-CN) dispatches exactly one langchange event with detail.lang === "zh-CN"', () => {
  dispatchCount = 0; lastEvent = null;
  setLang('zh-CN');
  assert.strictEqual(dispatchCount, 1, 'expected exactly one langchange dispatch');
  assert.ok(lastEvent, 'a langchange event object must be present');
  assert.strictEqual(lastEvent.type, 'langchange');
  assert.strictEqual(lastEvent.detail && lastEvent.detail.lang, 'zh-CN');
  assert.strictEqual(getLang(), 'zh-CN');
});

test('setLang(en) dispatches a langchange event with detail.lang === "en"', () => {
  dispatchCount = 0; lastEvent = null;
  setLang('en');
  assert.strictEqual(dispatchCount, 1);
  assert.strictEqual(lastEvent.type, 'langchange');
  assert.strictEqual(lastEvent.detail && lastEvent.detail.lang, 'en');
  assert.strictEqual(getLang(), 'en');
});

test('setLang tolerates an unknown value by normalising to "en"', () => {
  dispatchCount = 0; lastEvent = null;
  setLang('fr'); // not a supported locale → treated as en
  assert.strictEqual(dispatchCount, 1);
  assert.strictEqual(lastEvent.detail.lang, 'en');
  assert.strictEqual(getLang(), 'en');
});
