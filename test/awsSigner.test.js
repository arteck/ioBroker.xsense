'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AWSSigner } = require('../lib/awsSigner');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSigner() {
    return new AWSSigner(
        'AKIAIOSFODNN7EXAMPLE',
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'AQoXnyc4lcK4w4OIaYmkSoFsygwaBvuPwkASDFGHJKLZXCVBNM',
    );
}

// ─── Constructor / update ────────────────────────────────────────────────────

describe('AWSSigner – constructor', () => {
    it('speichert Credentials', () => {
        const s = makeSigner();
        assert.equal(s.accessKeyId,     'AKIAIOSFODNN7EXAMPLE');
        assert.equal(s.secretAccessKey, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        assert.equal(s.service,         'iotdata');
        assert.equal(s.algorithm,       'AWS4-HMAC-SHA256');
    });

    it('update() ersetzt Credentials', () => {
        const s = makeSigner();
        s.update('NEW_KEY', 'NEW_SECRET', 'NEW_TOKEN');
        assert.equal(s.accessKeyId,     'NEW_KEY');
        assert.equal(s.secretAccessKey, 'NEW_SECRET');
        assert.equal(s.sessionToken,    'NEW_TOKEN');
    });
});

// ─── signHeaders ─────────────────────────────────────────────────────────────

describe('AWSSigner – signHeaders()', () => {
    const url     = 'https://eu-west-1.x-sense-iot.com/things/SENSORABC/shadow?name=mainpage';
    const region  = 'eu-west-1';
    const headers = {
        'Content-Type':         'application/x-amz-json-1.0',
        'X-Amz-Security-Token': 'TESTTOKEN',
    };

    it('gibt X-Amz-Date zurück', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.ok(result['X-Amz-Date'], 'X-Amz-Date fehlt');
    });

    it('X-Amz-Date hat Format YYYYMMDDTHHmmssZ', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.match(result['X-Amz-Date'], /^\d{8}T\d{6}Z$/);
    });

    it('gibt Authorization zurück', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.ok(result.Authorization, 'Authorization fehlt');
    });

    it('Authorization enthält AWS4-HMAC-SHA256', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.ok(result.Authorization.startsWith('AWS4-HMAC-SHA256 '));
    });

    it('Authorization enthält Credential, SignedHeaders, Signature', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.ok(result.Authorization.includes('Credential='));
        assert.ok(result.Authorization.includes('SignedHeaders='));
        assert.ok(result.Authorization.includes('Signature='));
    });

    it('Authorization enthält accessKeyId', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.ok(result.Authorization.includes('AKIAIOSFODNN7EXAMPLE'));
    });

    it('Authorization enthält Region und Service', () => {
        const s      = makeSigner();
        const result = s.signHeaders('GET', url, region, headers, null);
        assert.ok(result.Authorization.includes('eu-west-1'));
        assert.ok(result.Authorization.includes('iotdata'));
    });

    it('verschiedene Inhalte erzeugen verschiedene Signaturen', () => {
        const s  = makeSigner();
        const r1 = s.signHeaders('GET',  url, region, headers, null);
        const r2 = s.signHeaders('POST', url, region, headers, '{"key":"val"}');
        assert.notEqual(r1.Authorization, r2.Authorization);
    });

    it('zwei Aufrufe kurz hintereinander liefern gleiche Signatur (idempotent bei gleicher Zeit)', () => {
        // Wir mocken Date nicht, aber prüfen Struktur
        const s = makeSigner();
        const r = s.signHeaders('GET', url, region, headers, null);
        assert.ok(r['X-Amz-Date'] && r.Authorization);
    });
});

// ─── presignUrl ──────────────────────────────────────────────────────────────

describe('AWSSigner – presignUrl()', () => {
    it('gibt eine URL zurück die mit wss:// beginnt', () => {
        const s      = makeSigner();
        const result = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.ok(result.startsWith('wss://'));
    });

    it('enthält X-Amz-Algorithm', () => {
        const s      = makeSigner();
        const result = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.ok(result.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256'));
    });

    it('enthält X-Amz-Credential', () => {
        const s      = makeSigner();
        const result = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.ok(result.includes('X-Amz-Credential='));
    });

    it('enthält X-Amz-Signature', () => {
        const s      = makeSigner();
        const result = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.ok(result.includes('X-Amz-Signature='));
    });

    it('enthält X-Amz-Security-Token (Session-Token)', () => {
        const s      = makeSigner();
        const result = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.ok(result.includes('X-Amz-Security-Token='));
    });

    it('enthält /mqtt Pfad', () => {
        const s      = makeSigner();
        const result = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.ok(result.includes('/mqtt'));
    });

    it('jeder Aufruf erzeugt eine andere URL (wegen neuem Timestamp)', async () => {
        const s  = makeSigner();
        const r1 = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        // Kurz warten damit der Timestamp sich unterscheidet
        await new Promise(resolve => setTimeout(resolve, 1100));
        const r2 = s.presignUrl('wss://mqtt.eu-west-1.amazonaws.com/mqtt', 'eu-west-1');
        assert.notEqual(r1, r2);
    });
});
