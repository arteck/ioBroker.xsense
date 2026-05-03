'use strict';

/**
 * AWS Cognito SRP-6a Authentication
 *
 * Nutzt AuthenticationHelper aus amazon-cognito-identity-js (lib/AuthenticationHelper.js)
 * – die offizielle AWS-Referenzimplementierung mit BigInteger aus dem Paket.
 */

const crypto = require('node:crypto');

// AuthenticationHelper und BigInteger direkt aus dem lib-Verzeichnis laden
const AuthenticationHelper = require('amazon-cognito-identity-js/lib/AuthenticationHelper').default;
const BigInteger = require('amazon-cognito-identity-js/lib/BigInteger').default;

// ─── CognitoSRP ───────────────────────────────────────────────────────────────

/**
 *
 */
class CognitoSRP {
    /**
     * @param {string}  userPoolId    z.B. "eu-west-1_AbcDEFGhI"
     * @param {string}  clientId      Cognito App Client ID
     * @param {Buffer}  clientSecret  Decoded + sliced client secret (Buffer)
     */
    constructor(userPoolId, clientId, clientSecret) {
        this.userPoolId = userPoolId;
        this.poolName = userPoolId.split('_')[1]; // Teil nach dem Unterstrich
        this.clientId = clientId;
        this.clientSecret = clientSecret;

        // Offizielle SRP-Implementierung mit korrektem BigInteger + padHex + HKDF
        this._helper = new AuthenticationHelper(this.poolName);
    }

    /**
     * SRP_A als Hex-String (für InitiateAuth → SRP_A Parameter).
     * Muss synchron verfügbar sein → getLargeAValue mit Callback aufrufen.
     *
     * @returns {Promise<string>}
     */
    getSrpAAsync() {
        return new Promise((resolve, reject) => {
            this._helper.getLargeAValue((err, largeA) => {
                if (err) {
                    return reject(err);
                }
                resolve(largeA.toString(16));
            });
        });
    }

    /**
     * SRP_A als Hex-String – synchron (largeAValue muss bereits berechnet sein).
     * Fallback falls getLargeAValue bereits beim Konstruktor durchlief.
     *
     * @returns {string}
     */
    getSrpA() {
        if (this._helper.largeAValue) {
            return this._helper.largeAValue.toString(16);
        }
        // Noch nicht fertig – trotzdem synchron initiieren (sehr selten)
        throw new Error('SRP_A noch nicht bereit – getSrpAAsync() verwenden');
    }

    /**
     * SECRET_HASH = Base64( HMAC-SHA256( clientSecret, username + clientId ) )
     *
     * @param {string} username
     * @returns {string}
     */
    computeSecretHash(username) {
        return crypto
            .createHmac('sha256', this.clientSecret)
            .update(username + this.clientId)
            .digest('base64');
    }

    /**
     * Verarbeitet die PASSWORD_VERIFIER Challenge.
     * Delegiert die gesamte SRP-Berechnung an AuthenticationHelper.getPasswordAuthenticationKey().
     *
     * @param {object} challengeParams  ChallengeParameters von Cognito
     * @param {string} password
     * @returns {Promise<{ TIMESTAMP, USERNAME, PASSWORD_CLAIM_SECRET_BLOCK, PASSWORD_CLAIM_SIGNATURE }>}
     */
    processChallenge(challengeParams, password) {
        const serverBHex = challengeParams.SRP_B;
        const saltHex = challengeParams.SALT;
        const secretBlock = challengeParams.SECRET_BLOCK;
        const userId = challengeParams.USER_ID_FOR_SRP;

        // Beide Werte als BigInteger übergeben – so wie AuthenticationHelper es erwartet
        const serverBValue = new BigInteger(serverBHex, 16);
        const saltValue = new BigInteger(saltHex, 16);

        return new Promise((resolve, reject) => {
            this._helper.getPasswordAuthenticationKey(
                userId,
                password,
                serverBValue,
                saltValue,
                (err, hkdfKey) => {
                    if (err) {
                        return reject(err);
                    }

                    const timestamp = _cognitoTimestamp();
                    const secretBlockBuf = Buffer.from(secretBlock, 'base64');

                    const msg = Buffer.concat([
                        Buffer.from(this.poolName, 'utf-8'),
                        Buffer.from(userId, 'utf-8'),
                        secretBlockBuf,
                        Buffer.from(timestamp, 'utf-8'),
                    ]);

                    const signature = crypto
                        .createHmac('sha256', hkdfKey)
                        .update(msg)
                        .digest('base64');

                    resolve({
                        TIMESTAMP: timestamp,
                        USERNAME: userId,
                        PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
                        PASSWORD_CLAIM_SIGNATURE: signature,
                    });
                }
            );
        });
    }
}

// ─── Timestamp im AWS-Cognito-Format ─────────────────────────────────────────

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function _cognitoTimestamp() {
    const now = new Date();
    const day = _DAYS[now.getUTCDay()];
    const mon = _MONTHS[now.getUTCMonth()];
    const d = now.getUTCDate();                          // KEIN padStart – AWS will "3", nicht " 3"
    const H = String(now.getUTCHours()).padStart(2, '0');
    const M = String(now.getUTCMinutes()).padStart(2, '0');
    const S = String(now.getUTCSeconds()).padStart(2, '0');
    return `${day} ${mon} ${d} ${H}:${M}:${S} UTC ${now.getUTCFullYear()}`;
}

module.exports = {CognitoSRP};
