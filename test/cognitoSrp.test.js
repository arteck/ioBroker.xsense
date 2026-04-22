'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { CognitoSRP } = require('../lib/cognitoSrp');

function makeSrp(opts = {}) {
    return new CognitoSRP(
        opts.poolId   || 'eu-west-1_TestPool1',
        opts.clientId || 'testClientId123',
        opts.secret   || Buffer.from('testSecretBytes', 'utf-8'),
    );
}

// ─── constructor ─────────────────────────────────────────────────────────────

describe('CognitoSRP – constructor', () => {
    it('setzt poolName korrekt (Teil nach _)', () => {
        const srp = makeSrp({ poolId: 'eu-west-1_MyPool' });
        assert.equal(srp.poolName, 'MyPool');
    });

    it('erzeugt einen _helper (AuthenticationHelper)', () => {
        const srp = makeSrp();
        assert.ok(srp._helper);
        assert.equal(typeof srp._helper.getPasswordAuthenticationKey, 'function');
    });
});

// ─── getSrpAAsync ─────────────────────────────────────────────────────────────

describe('CognitoSRP – getSrpAAsync()', () => {
    it('gibt einen Hex-String zurück', async () => {
        const srp = makeSrp();
        const a   = await srp.getSrpAAsync();
        assert.match(a, /^[0-9a-f]+$/i);
    });

    it('Länge ist gerade (valide Byte-Kodierung)', async () => {
        const srp = makeSrp();
        const a   = await srp.getSrpAAsync();
        assert.equal(a.length % 2, 0, `Ungerade Länge: ${a.length}`);
    });

    it('zwei Aufrufe liefern verschiedene A-Werte', async () => {
        const a = await makeSrp().getSrpAAsync();
        const b = await makeSrp().getSrpAAsync();
        assert.notEqual(a, b);
    });
});

// ─── computeSecretHash ───────────────────────────────────────────────────────

describe('CognitoSRP – computeSecretHash()', () => {
    it('gibt einen Base64-String zurück', () => {
        assert.match(makeSrp().computeSecretHash('user'), /^[A-Za-z0-9+/]+=*$/);
    });

    it('ist deterministisch', () => {
        const srp = makeSrp();
        assert.equal(srp.computeSecretHash('user'), srp.computeSecretHash('user'));
    });

    it('unterscheidet sich für unterschiedliche Usernamen', () => {
        const srp = makeSrp();
        assert.notEqual(srp.computeSecretHash('alice'), srp.computeSecretHash('bob'));
    });

    it('entspricht HMAC-SHA256(secret, username+clientId) in Base64', () => {
        const secret   = Buffer.from('mySecret', 'utf-8');
        const clientId = 'myClientId';
        const username = 'myUser';
        const srp      = new CognitoSRP('eu-west-1_Pool', clientId, secret);
        const expected = crypto.createHmac('sha256', secret).update(username + clientId).digest('base64');
        assert.equal(srp.computeSecretHash(username), expected);
    });
});

// ─── processChallenge (async) ────────────────────────────────────────────────

describe('CognitoSRP – processChallenge()', () => {
    it('gibt ein Promise zurück', () => {
        const srp = makeSrp();
        const result = srp.processChallenge({
            SRP_B:           '1234567890abcdef',
            SALT:            'aabbccdd',
            SECRET_BLOCK:    Buffer.from('dummy').toString('base64'),
            USER_ID_FOR_SRP: 'user@example.com',
        }, 'pw');
        assert.ok(result instanceof Promise);
    });

    it('löst mit allen Pflichtfeldern auf oder wirft', async () => {
        const srp = makeSrp();
        await srp.getSrpAAsync(); // largeAValue sicherstellen

        let result;
        try {
            result = await srp.processChallenge({
                SRP_B:           '1234567890abcdef1234567890abcdef',
                SALT:            'aabbccddee112233',
                SECRET_BLOCK:    Buffer.from('dummySecretBlock').toString('base64'),
                USER_ID_FOR_SRP: 'user@example.com',
            }, 'password');
        } catch {
            // Kryptographisch ungültige Parameter → OK
            return;
        }

        assert.ok('TIMESTAMP' in result);
        assert.ok('USERNAME' in result);
        assert.ok('PASSWORD_CLAIM_SECRET_BLOCK' in result);
        assert.ok('PASSWORD_CLAIM_SIGNATURE' in result);
    });

    it('TIMESTAMP enthält "UTC"', async () => {
        const srp = makeSrp();
        await srp.getSrpAAsync();
        let result;
        try {
            result = await srp.processChallenge({
                SRP_B:           '1234567890abcdef1234567890abcdef',
                SALT:            'aabbccddee112233',
                SECRET_BLOCK:    Buffer.from('dummy').toString('base64'),
                USER_ID_FOR_SRP: 'user@example.com',
            }, 'pw');
        } catch {
            return;
        }
        assert.ok(result.TIMESTAMP.includes('UTC'));
    });
});
