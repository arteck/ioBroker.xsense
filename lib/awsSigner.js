'use strict';

/**
 * AWS Signature Version 4 + WebSocket Presign
 *
 * Portierung von python-xsense/xsense/aws_signer.py auf Node.js.
 * Service: iotdata (AWS IoT Data Plane)
 */

const crypto = require('node:crypto');

/**
 *
 */
class AWSSigner {
    /**
     * @param {string} accessKeyId     AWS Access Key ID
     * @param {string} secretAccessKey AWS Secret Access Key
     * @param {string} sessionToken    AWS Session Token (STS temporäres Token)
     */
    constructor(accessKeyId, secretAccessKey, sessionToken) {
        this.algorithm = 'AWS4-HMAC-SHA256';
        this.service   = 'iotdata';
        this.update(accessKeyId, secretAccessKey, sessionToken);
    }

    /**
     * Credentials aktualisieren (nach Token-Refresh)
     *
     * @param {string} accessKeyId     AWS Access Key ID
     * @param {string} secretAccessKey AWS Secret Access Key
     * @param {string} sessionToken    AWS Session Token (STS temporäres Token)
     */
    update(accessKeyId, secretAccessKey, sessionToken) {
        this.accessKeyId      = accessKeyId;
        this.secretAccessKey  = secretAccessKey;
        this.sessionToken     = sessionToken;
    }

    // ─── Private Helpers ─────────────────────────────────────────────────────

    /**
     * @param {Buffer|string} key  HMAC-Schlüssel
     * @param {string}        msg  Zu signierender String
     */
    sign(key, msg) {
        return crypto.createHmac('sha256', key).update(msg, 'utf-8').digest();
    }

    /**
     * @param {string} dateStamp  Datum im Format YYYYMMDD
     * @param {string} region     AWS-Region (z.B. "eu-west-1")
     */
    getSigningKey(dateStamp, region) {
        const kDate    = this.sign(Buffer.from(`AWS4${this.secretAccessKey}`, 'utf-8'), dateStamp);
        const kRegion  = this.sign(kDate, region);
        const kService = this.sign(kRegion, this.service);
        return this.sign(kService, 'aws4_request');
    }

    /**
     * @param {string|Buffer} data  Eingabedaten für SHA-256-Hash
     */
    sha256Hex(data) {
        return crypto.createHash('sha256').update(data || '').digest('hex');
    }

    /**
     * ISO-8601 Datum ohne Trennzeichen: 20240314T120000Z
     *
     * @returns {{ amzDate: string, dateStamp: string }} amzDate = vollständiger Timestamp, dateStamp = YYYYMMDD
     */
    timestamps() {
        const now       = new Date();
        const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').replace('T', 'T');
        const dateStamp = amzDate.slice(0, 8);
        return { amzDate, dateStamp };
    }

    // ─── Öffentliche API ─────────────────────────────────────────────────────

    /**
     * Signiert HTTP-Request-Header (SigV4) und gibt die zusätzlichen Header zurück.
     *
     * @param {string}          method       'GET' | 'POST'
     * @param {string}          url          Vollständige HTTPS-URL
     * @param {string}          region       AWS-Region
     * @param {object}          extraHeaders Bereits vorhandene Headers
     * @param {string|null}     content      Request-Body (für POST)
     * @returns {object}  Zu ergänzende Header { 'X-Amz-Date', 'Authorization' }
     */
    signHeaders(method, url, region, extraHeaders, content) {
        const parsedUrl             = new URL(url);
        const { amzDate, dateStamp } = this.timestamps();
        const scope                 = `${dateStamp}/${region}/${this.service}/aws4_request`;

        // Content-Hash
        let contentHash;
        if (content) {
            const contentStr = typeof content === 'object' ? JSON.stringify(content) : String(content);
            contentHash = this.sha256Hex(Buffer.from(contentStr, 'utf-8'));
        } else {
            contentHash = this.sha256Hex('');
        }

        // Alle Header sammeln und sortieren (lowercase Keys)
        const allHeaders = {
            host:         parsedUrl.host,
            ...extraHeaders,
            'x-amz-date': amzDate,
        };

        const canonicalHeaders = Object.entries(allHeaders)
            .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
            .sort(([a], [b]) => a.localeCompare(b));

        const canonicalHeadersStr = `${canonicalHeaders.map(([k, v]) => `${k}:${v}`).join('\n')  }\n`;
        const signedHeadersStr    = canonicalHeaders.map(([k]) => k).join(';');

        // Canonical Query String
        const queryEntries = [...parsedUrl.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
        const canonicalQuery = queryEntries
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');

        // Canonical Request
        const canonicalRequest = [
            method,
            parsedUrl.pathname,
            canonicalQuery,
            canonicalHeadersStr,
            signedHeadersStr,
            contentHash,
        ].join('\n');

        // String to Sign
        const stringToSign = [
            this.algorithm,
            amzDate,
            scope,
            this.sha256Hex(canonicalRequest),
        ].join('\n');

        // Signatur
        const signingKey  = this.getSigningKey(dateStamp, region);
        const signature   = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest('hex');
        const credential  = `${this.accessKeyId}/${scope}`;
        const authorization = `${this.algorithm} Credential=${credential}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

        return {
            'X-Amz-Date':   amzDate,
            Authorization:  authorization,
        };
    }

    /**
     * Erstellt eine vorzeichnete WebSocket-URL für AWS IoT MQTT.
     *
     * @param {string} url     wss://<endpoint>/mqtt
     * @param {string} region  AWS-Region
     * @returns {string}       Signierte WSS-URL
     */
    presignUrl(url, region) {
        const parsedUrl             = new URL(url);
        const { amzDate, dateStamp } = this.timestamps();
        const credentialScope       = `${dateStamp}/${region}/${this.service}/aws4_request`;
        const credential            = `${this.accessKeyId}/${credentialScope}`;

        // Canonical Query String (ohne Token und Signatur)
        const queryParts = [
            ['X-Amz-Algorithm',    this.algorithm],
            ['X-Amz-Credential',   credential],
            ['X-Amz-Date',         amzDate],
            ['X-Amz-SignedHeaders', 'host'],
        ];

        let canonicalQuery = queryParts
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&');

        const contentHash     = this.sha256Hex(''); // leer für WebSocket
        const canonicalHeaders = `host:${parsedUrl.hostname}\n`;

        const canonicalRequest = [
            'GET',
            parsedUrl.pathname,
            canonicalQuery,
            canonicalHeaders,
            'host',
            contentHash,
        ].join('\n');

        const stringToSign = [
            this.algorithm,
            amzDate,
            credentialScope,
            this.sha256Hex(canonicalRequest),
        ].join('\n');

        const signingKey = this.getSigningKey(dateStamp, region);
        const signature  = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest('hex');

        // Security Token + Signatur anhängen
        canonicalQuery += `&X-Amz-Security-Token=${encodeURIComponent(this.sessionToken)}`;
        canonicalQuery += `&X-Amz-Signature=${signature}`;

        return `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}?${canonicalQuery}`;
    }
}

module.exports = { AWSSigner };
