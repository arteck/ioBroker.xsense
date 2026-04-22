'use strict';

const assert = require('node:assert/strict');
const { isJson } = require('../lib/tools');

// ─────────────────────────────────────────────────────────────
// isJson
// ─────────────────────────────────────────────────────────────
describe('isJson()', () => {
    it('returns true for valid JSON object string', () => {
        assert.equal(isJson('{"key":"value"}'), true);
    });

    it('returns true for valid JSON array string', () => {
        assert.equal(isJson('[1,2,3]'), true);
    });

    it('returns false for plain string', () => {
        assert.equal(isJson('hello world'), false);
    });

    it('returns false for empty string', () => {
        assert.equal(isJson(''), false);
    });

    it('returns true for object (non-string input)', () => {
        assert.equal(isJson({ a: 1 }), true);
    });

    it('returns false for null', () => {
        assert.equal(isJson(null), false);
    });
});
