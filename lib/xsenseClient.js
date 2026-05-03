'use strict';

/**
 * XSense Cloud API Client
 *
 * Portierung von python-xsense/xsense/{base.py, xsense.py, mapping.py}
 *
 * Architektur:
 *   init()       → API 101001 – Client-Infos (clientId, clientSecret, region, userPoolId)
 *   login()      → AWS Cognito SRP → AccessToken, IdToken, RefreshToken
 *   refresh()    → Cognito REFRESH_TOKEN_AUTH → neue Tokens
 *   loadAws()    → API 101003 – temporäre AWS-Credentials (IoT-Signing)
 *   loadAll()    → API 102007/102008/103007 – Häuser, Räume, Stationen, Geräte
 *   getState()   → AWS IoT Thing Shadow – Gerätezustände
 *   testAlarm()  → AWS IoT Thing Shadow (POST) – Testalarm auslösen
 */

const crypto = require('node:crypto');
const {CognitoSRP} = require('./cognitoSrp');
const {AWSSigner} = require('./awsSigner');
const {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand
} = require('@aws-sdk/client-cognito-identity-provider');

// ─── Konstanten ───────────────────────────────────────────────────────────────

const API_URL = 'https://api.x-sense-iot.com';
const VERSION = 'v1.18.0_20240311';
const APPCODE = '1180';
const CLIENT_TYPE = '1';

/** Wie viele Sekunden vor Ablauf ein Token als "ablaufend" gilt */
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Default Poll-Intervall: 300s (5 Min) – entspricht HA DEFAULT_SCAN_INTERVAL.
 * Kürzere Intervalle sind unnötig, da Echtzeit-Updates via MQTT kommen.
 */
const DEFAULT_SCAN_INTERVAL_S = 300;

/**
 * Für MQTT-Push-Abruf von Temperatursensoren (STH51/STH0A).
 * Entspricht HA POLL_INTERVAL_MIN.
 */
const POLL_INTERVAL_MIN = 5;

/**
 * Gerätetypen die einen aktiven MQTT-Publish brauchen um Live-Daten zu liefern.
 * Quelle: HA coordinator.py → request_device_updates()
 */
const REALTIME_DEVICE_TYPES = ['STH51', 'STH0A'];

/** RF-Signal-Level-Mapping (0–3) – Quelle: HA const.py STATE_SIGNAL */
const STATE_SIGNAL = ['no_signal', 'weak', 'moderate', 'good'];

/**
 * Berechnet den Batterie-Prozentsatz aus batInfo (0–3).
 * Quelle: HA sensor.py → batInfo * 100 / 3
 *
 * @param {number} batInfo  Rohwert 0–3 aus der API (0=leer, 3=voll)
 * @returns {number} Prozentwert 0–100
 */
function batInfoToPercent(batInfo) {
    return Math.round((Number(batInfo) * 100) / 3);
}

/**
 * Gibt den Signalstärke-String für einen rfLevel-Wert zurück.
 *
 * @param {number|string} rfLevel  Rohwert 0–3 aus der API
 * @returns {string}  Einer von: 'no_signal' | 'weak' | 'moderate' | 'good'
 */
function rfLevelToString(rfLevel) {
    return STATE_SIGNAL[parseInt(rfLevel, 10)] || 'no_signal';
}

// ─── Property-Mapping (python: mapping.py) ───────────────────────────────────

const PROPERTY_MAP = {
    '*': {wifiRssi: 'wifiRSSI'},
    STH0A: {
        a: 'alarmStatus',
        b: 'temperature',
        c: 'humidity',
        d: 'temperatureUnit',
        e: 'temperatureRange',
        f: 'humidityRange',
        g: 'alarmEnabled',
        h: 'continuedAlarm',
        t: 'time'
    },
    STH51: {
        a: 'alarmStatus',
        b: 'temperature',
        c: 'humidity',
        d: 'temperatureUnit',
        e: 'temperatureRange',
        f: 'humidityRange',
        g: 'alarmEnabled',
        h: 'continuedAlarm',
        t: 'time'
    },
};

const TYPE_MAPPERS = {
    batInfo: v => parseInt(v, 10),
    rfLevel: v => parseInt(v, 10),
    alarmStatus: v => v === '1' || v === true,
    alarmEnabled: v => v === '1' || v === true,
    muteStatus: v => v === '1' || v === true,
    continuedAlarm: v => v === '1' || v === true,
    coPpm: v => parseInt(v, 10),
    coLevel: v => parseInt(v, 10),
    isLifeEnd: v => v === '1' || v === true,
    temperature: v => parseFloat(v),
    humidity: v => parseFloat(v),
    wifiRSSI: v => parseInt(v, 10),
};

/**
 * Wendet Property-Rename + Type-Mapping an.
 *
 * @param {string} deviceType  Gerätetyp-String, z.B. 'STH0A' – bestimmt Spalten-Mapping
 * @param {object} data        Rohdaten-Objekt aus API oder Shadow
 * @returns {object}           Gemapptes Objekt mit korrekten Typen und Property-Namen
 */
function mapValues(deviceType, data) {
    if (!data || typeof data !== 'object') {
        return {};
    }
    const mapping = {...(PROPERTY_MAP['*'] || {}), ...(PROPERTY_MAP[deviceType] || {})};
    const result = {};
    for (const [k, v] of Object.entries(data)) {
        const mappedKey = mapping[k] || k;
        const mapper = TYPE_MAPPERS[mappedKey];
        result[mappedKey] = mapper ? mapper(v) : v;
    }
    return result;
}

// ─── Action-Definitionen (python: entity_map.py) ─────────────────────────────

/**
 * Gibt die Action-Definition für einen Gerätetyp zurück.
 *
 * @param {string} deviceType  Gerätetyp, z.B. 'SC06-WX', 'STH0A'
 * @param {string} action      Aktion: 'test' | 'mute' | 'firedrill'
 * @param {object} device      Geräteobjekt mit mindestens { serial, type }
 * @returns {{ shadow: string, topic: string }|null}  Action-Definition oder null wenn nicht unterstützt
 */
function resolveAction(deviceType, action, device) {
    const sn = device.serial;

    const ACTION_MAP = {
        'SC06-WX_test': {shadow: 'appSelfTest', topic: `2nd_selftest_${sn}`},
        'SC07-MR_test': {shadow: 'app2ndSelfTest', topic: `2nd_selftest_${sn}`},
        'SC07-WX_mute': {shadow: '1', topic: '2nd_appmute'},
        STH0A_test: {shadow: 'thSelfTest', topic: `2nd_selftest_${sn}`},
        STH51_test: {shadow: 'thSelfTest', topic: `2nd_selftest_${sn}`},
        STH0A_mute: {shadow: '1', topic: 'extendMute'},
        STH51_mute: {shadow: '1', topic: 'extendMute'},
        SWS51_test: {shadow: 'waterSelfTest', topic: `2nd_selftest_${sn}`},
        SWS51_mute: {shadow: 'appWater', topic: '2nd_appwater'},
        'XC01-M_test': {shadow: 'appCoSelfTest', topic: `2nd_selftest_${sn}`},
        'XC01-M_mute': {shadow: '1', topic: 'appCoMute'},
        'XC04-WX_mute': {shadow: '1', topic: '2nd_appmute'},
        'XH02-M_test': {shadow: 'appXh02mSelfTest', topic: `2nd_selftest_${sn}`},
        'XP0A-MR_test': {shadow: 'app2ndSelfTest', topic: `2nd_selftest_${sn}`},
        'XP0A-MR_drill': {shadow: 'appFireDrill', topic: '2nd_firedrill'},
        'XP02S-MR_test': {shadow: 'app2ndSelfTest', topic: `2nd_selftest_${sn}`},
        'XS0B-MR_test': {shadow: 'appSelfTest', topic: `2nd_selftest_${sn}`},
        'XS0B-MR_mute': {shadow: 'appMute', topic: '2nd_appmute'},
        'XS0B-MR_drill': {shadow: 'appFireDrill', topic: '2nd_firedrill'},
        'XS0D-MR_test': {shadow: 'appSelfTest', topic: `2nd_selftest_${sn}`},
        'XS01-M_test': {shadow: 'appSelfTest', topic: `2nd_selftest_${sn}`},
        'XS01-M_mute': {shadow: 'appMute', topic: '2nd_appmute'},
        'XS01-WX_test': {shadow: 'appSelfTest', topic: `2nd_selftest_${sn}`},
        // Standalone-Geräte
        default_test: {shadow: 'appSelfTest', topic: `appselftest_${sn}`},
        default_mute: {shadow: 'appMute', topic: '2nd_appmute'},
    };

    return ACTION_MAP[`${deviceType}_${action}`] || ACTION_MAP[`default_${action}`] || null;
}

// ─── XSenseClient ─────────────────────────────────────────────────────────────

/**
 *
 */
class XSenseClient {
    /**
     * @param {{ debug: Function, info: Function, warn: Function, error: Function }} log  ioBroker Logger-Objekt
     */
    constructor(log) {
        this.log = log;

        // Client-Infos (von API 101001)
        this.clientId = null;
        this.clientSecret = null; // Buffer

        this.region = null;
        this.userPoolId = null;

        // Cognito-Auth-Tokens
        this.username = null;
        this.userId = null;
        this.accessToken = null;
        this.idToken = null;
        this.refreshToken = null;
        this.accessTokenExpiry = 0; // ms timestamp

        // AWS-IoT-Credentials
        this.awsAccessKey = null;
        this.awsSecretAccessKey = null;
        this.awsSessionToken = null;
        this.awsAccessExpiry = 0; // ms timestamp
        this.signer = null;

        // Geräte-Cache
        this.houses = {};
    }

    // ─── Secret-Handling (python: _decode_secret, _calculate_mac, generate_hash) ──

    /**
     * Base64-dekodiert und entfernt 4-Byte-Header + 1-Byte-Trailer
     * (repräsentiert den internen clientSecret-Format von X-Sense)
     *
     * @param {string} encoded  Base64-kodierter clientSecret-String aus API 101001
     * @returns {Buffer}        Dekodierter Secret-Buffer ohne Header/Trailer
     */
    decodeSecret(encoded) {
        const raw = Buffer.from(encoded, 'base64');
        return raw.slice(4, -1);
    }

    /**
     * MAC = MD5( concat_values_utf8 + clientSecret_bytes )
     * Entspricht python: _calculate_mac()
     *
     * @param {object} data  Request-Parameter-Objekt dessen Werte in den MAC einfließen
     * @returns {string}     MD5-Hex-String (32 Zeichen)
     */
    calculateMac(data) {
        const values = [];
        if (data) {
            for (const value of Object.values(data)) {
                if (Array.isArray(value)) {
                    if (value.length > 0 && typeof value[0] === 'string') {
                        values.push(...value);
                    } else {
                        values.push(JSON.stringify(value));
                    }
                } else if (typeof value === 'object' && value !== null) {
                    values.push(JSON.stringify(value));
                } else {
                    values.push(String(value));
                }
            }
        }
        const concatenated = values.join('');
        const macData = Buffer.concat([Buffer.from(concatenated, 'utf-8'), this.clientSecret]);
        return crypto.createHash('md5').update(macData).digest('hex');
    }

    // ─── Token-Ablauf-Prüfungen ───────────────────────────────────────────────

    /**
     *
     */
    isAccessTokenExpiring() {
        return !this.accessToken || Date.now() > this.accessTokenExpiry - TOKEN_REFRESH_BUFFER_MS;
    }

    /**
     *
     */
    isAwsTokenExpiring() {
        return !this.awsAccessKey || Date.now() > this.awsAccessExpiry - TOKEN_REFRESH_BUFFER_MS;
    }

    // ─── API-Call (python: api_call) ─────────────────────────────────────────

    /**
     * Sendet einen Request an die X-Sense API.
     *
     * @param {string}  bizCode         API-Endpunkt-Code, z.B. '102007'
     * @param {boolean} unauth          true = kein Authorization-Header (für init)
     * @param {object}  params          Zusätzliche Request-Parameter
     * @returns {Promise<object>}       reData aus der API-Antwort
     */
    async apiCall(bizCode, unauth = false, params = {}) {
        if (!unauth && this.isAccessTokenExpiring()) {
            await this.refresh();
        }

        const headers = {'Content-Type': 'application/json'};
        let mac;

        if (unauth) {
            mac = 'abcdefg';
        } else {
            headers['Authorization'] = this.accessToken;
            mac = this.calculateMac(params);
        }

        const body = {
            ...params,
            clientType: CLIENT_TYPE,
            mac,
            appVersion: VERSION,
            bizCode,
            appCode: APPCODE,
        };

        let response;
        try {
            response = await fetch(`${API_URL}/app`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            throw new Error(`[XSense API] Netzwerkfehler bei bizCode ${bizCode}: ${err.message}`);
        }

        if (response.status >= 400) {
            throw new Error(`[XSense API] HTTP ${response.status} bei bizCode ${bizCode}`);
        }

        const data = await response.json();

        if (!('reCode' in data)) {
            throw new Error('[XSense API] Antwort enthält kein reCode');
        }

        if (data.reCode !== 200) {
            const errCode = data.errCode || 0;
            if (errCode === '10000008' || errCode === '10000020') {
                throw new Error(`SessionExpired: ${data.reMsg}`);
            }
            throw new Error(`[XSense API] bizCode ${bizCode} Fehler: ${errCode}/${data.reCode} ${data.reMsg}`);
        }

        return data.reData;
    }

    // ─── Initialisierung (python: init + get_client_info) ────────────────────

    /**
     * Holt Client-Infos von der API (clientId, clientSecret, region, userPoolId).
     * Muss vor login() aufgerufen werden.
     */
    async init() {
        this.log.debug('[XSense] init – lade Client-Infos');
        const data = await this.apiCall('101001', true);

        this.clientId = data.clientId;
        this.clientSecret = this.decodeSecret(data.clientSecret);
        this.region = data.cgtRegion;
        this.userPoolId = data.userPoolId;

        this.log.debug(`[XSense] Client-Infos: region=${this.region}, pool=${this.userPoolId}`);
    }

    // ─── Cognito Login (python: sync_login + login + load_aws) ───────────────

    /**
     * Vollständiger Login via AWS Cognito SRP.
     * Holt anschliessend AWS-IoT-Credentials via loadAws().
     *
     * @param {string} username  E-Mail-Adresse des X-Sense Kontos
     * @param {string} password  Passwort des X-Sense Kontos
     */
    async login(username, password) {
        if (!this.clientId) {
            throw new Error('[XSense] init() muss vor login() aufgerufen werden');
        }

        this.username = username;
        this.log.debug('[XSense] Starte Cognito SRP Login...');

        const srp = new CognitoSRP(this.userPoolId, this.clientId, this.clientSecret);

        const cognitoClient = new CognitoIdentityProviderClient({region: this.region});

        // ── Step 1: USER_SRP_AUTH ──
        const srpA = await srp.getSrpAAsync();

        const initResponse = await cognitoClient.send(new InitiateAuthCommand({
            ClientId: this.clientId,
            AuthFlow: 'USER_SRP_AUTH',
            AuthParameters: {
                USERNAME: username,
                SRP_A: srpA,
                SECRET_HASH: srp.computeSecretHash(username),
            },
        }));

        if (initResponse.ChallengeName !== 'PASSWORD_VERIFIER') {
            throw new Error(`[XSense] Unerwartete Cognito Challenge: ${initResponse.ChallengeName}`);
        }

        // USER_ID_FOR_SRP kann vom originalen username abweichen
        this.userId = initResponse.ChallengeParameters?.USER_ID_FOR_SRP || username;

        // ── Step 2: PASSWORD_VERIFIER ──
        const challengeResponses = await srp.processChallenge(initResponse.ChallengeParameters, password);
        challengeResponses.SECRET_HASH = srp.computeSecretHash(this.userId);

        const authResponse = await cognitoClient.send(new RespondToAuthChallengeCommand({
            ClientId: this.clientId,
            ChallengeName: 'PASSWORD_VERIFIER',
            ChallengeResponses: challengeResponses,
        }));

        const authResult = authResponse.AuthenticationResult;
        if (!authResult) {
            throw new Error('[XSense] Cognito hat kein AuthenticationResult zurückgegeben');
        }

        this.accessToken = authResult.AccessToken;
        this.idToken = authResult.IdToken;
        this.refreshToken = authResult.RefreshToken;
        this.accessTokenExpiry = Date.now() + authResult.ExpiresIn * 1000;

        this.log.info('[XSense] Cognito Login erfolgreich');

        await this.loadAws();
    }

    // ─── Token-Refresh (python: refresh) ─────────────────────────────────────

    /**
     * Erneuert Access- und IdToken via REFRESH_TOKEN_AUTH.
     */
    async refresh() {
        this.log.debug('[XSense] Token-Refresh...');

        if (!this.refreshToken) {
            throw new Error('[XSense] Kein RefreshToken vorhanden – erneutes Login erforderlich');
        }

        const cognitoClient = new CognitoIdentityProviderClient({region: this.region});

        // Hinweis: Die Python-Implementierung verwendet clientsecret.decode() direkt als SECRET_HASH,
        // nicht den HMAC-Wert. Dieses Verhalten wird hier 1:1 nachgeahmt.
        const secretHashRaw = this.clientSecret.toString('utf-8');

        let response;
        try {
            response = await cognitoClient.send(new InitiateAuthCommand({
                ClientId: this.clientId,
                AuthFlow: 'REFRESH_TOKEN_AUTH',
                AuthParameters: {
                    REFRESH_TOKEN: this.refreshToken,
                    SECRET_HASH: secretHashRaw,
                },
            }));
        } catch (err) {
            if (err.name === 'NotAuthorizedException' || err.$metadata?.httpStatusCode === 400) {
                throw new Error('SessionExpired: Token-Refresh fehlgeschlagen');
            }
            throw err;
        }

        const authResult = response.AuthenticationResult;
        if (authResult) {
            if (authResult.AccessToken) {
                this.accessToken = authResult.AccessToken;
                this.accessTokenExpiry = Date.now() + (authResult.ExpiresIn || 3600) * 1000;
            }
            if (authResult.IdToken) {
                this.idToken = authResult.IdToken;
            }
        }

        this.log.debug('[XSense] Token-Refresh erfolgreich');
    }

    // ─── AWS-IoT-Credentials (python: load_aws + get_aws_tokens) ─────────────

    /**
     * Holt temporäre AWS-Credentials für IoT-Signing (API 101003).
     */
    async loadAws() {
        this.log.debug('[XSense] Lade AWS-Credentials...');

        const data = await this.apiCall('101003', false, {userName: this.username});

        this.awsAccessKey = data.accessKeyId;
        this.awsSecretAccessKey = data.secretAccessKey;
        this.awsSessionToken = data.sessionToken;
        // Format: "2024-01-01 12:00:00+00:00" oder ISO
        this.awsAccessExpiry = new Date(data.expiration).getTime();

        if (this.signer) {
            this.signer.update(this.awsAccessKey, this.awsSecretAccessKey, this.awsSessionToken);
        } else {
            this.signer = new AWSSigner(this.awsAccessKey, this.awsSecretAccessKey, this.awsSessionToken);
        }

        this.log.debug('[XSense] AWS-Credentials geladen');
    }

    // ─── Daten laden (python: load_all) ──────────────────────────────────────

    /**
     * Lädt alle Häuser, Stationen und Geräte.
     * Füllt this.houses.
     */
    async loadAll() {
        this.log.debug('[XSense] loadAll – lade Häuser/Stationen/Geräte');

        const housesData = await this.apiCall('102007', false, {utctimestamp: '0'});
        const result = {};

        for (const h of (housesData || [])) {
            const house = {
                houseId: h.houseId,
                name: h.houseName,
                region: h.houseRegion,
                mqttRegion: h.mqttRegion,
                mqttServer: h.mqttServer,
                rooms: {},
                stations: {},
            };

            // Räume
            try {
                const roomsData = await this.apiCall('102008', false, {houseId: h.houseId, utctimestamp: '0'});
                house.rooms = roomsData || {};
            } catch (e) {
                this.log.warn(`[XSense] Räume für Haus ${h.houseId} konnten nicht geladen werden: ${e.message}`);
            }

            // Stationen + Geräte
            try {
                const stationsData = await this.apiCall('103007', false, {houseId: h.houseId, utctimestamp: '0'});
                for (const s of (stationsData?.stations || [])) {
                    const station = {
                        stationId: s.stationId,
                        name: s.stationName,
                        serial: s.stationSn,
                        type: s.category,
                        online: s.onLine ?? true,
                        data: {},
                        devices: {},
                        // Flache Felder vom Haus – kein Rück-Referenz auf das Haus-Objekt
                        houseId:    h.houseId,
                        mqttRegion: h.mqttRegion,
                        mqttServer: h.mqttServer,
                    };

                    for (const d of (s.devices || [])) {
                        station.devices[d.deviceId] = {
                            deviceId: d.deviceId,
                            name: d.deviceName || d.deviceSn,
                            serial: d.deviceSn,
                            type: d.category,
                            online: d.onLine ?? true,
                            data: {},
                            // Flaches Feld – kein Rück-Referenz auf die Station
                            stationSerial: s.stationSn,
                        };
                    }

                    house.stations[s.stationId] = station;
                }
            } catch (e) {
                this.log.warn(`[XSense] Stationen für Haus ${h.houseId} konnten nicht geladen werden: ${e.message}`);
            }

            result[h.houseId] = house;
        }

        this.houses = result;
        this.log.debug(`[XSense] ${Object.keys(result).length} Häuser geladen`);
    }

    // ─── Thing Shadow (python: get_thing, get_state) ──────────────────────────

    /**
     * Holt den AWS IoT Thing Shadow für eine Station.
     *
     * @param {object} station  Station-Objekt mit { serial, type, house }
     * @param {string} page     Shadow-Name, z.B. 'mainpage' oder '2nd_mainpage'
     * @returns {Promise<object|null>}  Shadow-Antwort oder null bei 404
     */
    async getThingShadow(station, page) {
        if (this.isAwsTokenExpiring()) {
            await this.loadAws();
        }

        let typeName = station.type || '';
        if (typeName === 'SBS10') {
            typeName = '';
        }
        if (typeName === 'XC04-WX' || typeName === 'SC07-WX') {
            typeName += '-';
        }

        const host = `${station.mqttRegion}.x-sense-iot.com`;
        const uri = `/things/${typeName}${station.serial}/shadow?name=${page}`;
        const url = `https://${host}${uri}`;

        const baseHeaders = {
            'Content-Type': 'application/x-amz-json-1.0',
            'User-Agent': 'aws-sdk-iOS/2.26.5 iOS/17.3 nl_NL',
            'X-Amz-Security-Token': this.awsSessionToken,
        };

        const signedExtra = this.signer.signHeaders('GET', url, station.mqttRegion, baseHeaders, null);
        const headers = {...baseHeaders, ...signedExtra};

        let response;
        try {
            response = await fetch(url, {method: 'GET', headers});
        } catch (err) {
            throw new Error(`[XSense IoT] Netzwerkfehler bei Shadow ${page}: ${err.message}`);
        }

        if (response.status === 404) {
            return null;
        }

        if (response.status >= 400) {
            throw new Error(`[XSense IoT] HTTP ${response.status} bei Shadow ${page}`);
        }

        return await response.json();
    }

    /**
     * Holt den Gerätezustand für eine Station und befüllt station.devices[*].data.
     *
     * @param {object} station  Station-Objekt mit { serial, type, devices, house }
     */
    async getState(station) {
        if (!station.devices || Object.keys(station.devices).length === 0) {
            return;
        }

        let res = null;

        // SBS10 hat nur 'mainpage', andere erst '2nd_mainpage' versuchen
        if (station.type !== 'SBS10') {
            res = await this.getThingShadow(station, '2nd_mainpage');
        }

        if (!res) {
            res = await this.getThingShadow(station, 'mainpage');
        }

        if (!res) {
            this.log.debug(`[XSense] Kein Shadow für Station ${station.serial}`);
            return;
        }

        const reported = res?.state?.reported;
        if (reported) {
            this.parseReported(station, reported);
        }
    }

    /**
     * Parst das reported-Objekt eines Thing Shadows und befüllt Station + Geräte.
     *
     * Zwei Strukturvarianten (Quelle: HA coordinator.py async_event_received):
     *
     *  Variante A – MQTT-Push (neue Struktur):
     *    { stationSN: "SBS50ABC", devs: { "SENSOR001": { batInfo:"2", ... }, ... }, wifiRSSI: "-55" }
     *
     *  Variante B – REST Thing Shadow (klassische Struktur):
     *    { "SENSOR001": { batInfo:"2", ... }, wifiRSSI: "-55" }
     *    oder direkte flache Felder auf der Station.
     *
     * @param {object} station   Station-Objekt das befüllt wird
     * @param {object} reported  reported-Objekt aus dem Thing Shadow state
     */
    parseReported(station, reported) {
        // Flache Station-Felder (nicht-Objekte) immer auf Station schreiben
        const stationFlat = {};
        for (const [k, v] of Object.entries(reported)) {
            if (typeof v !== 'object' || v === null) {
                stationFlat[k] = v;
            }
        }
        if (Object.keys(stationFlat).length > 0) {
            station.data = {...station.data, ...mapValues(station.type, stationFlat)};
        }

        // ── Variante A: devs{} Substruktur (MQTT-Push) ──
        if (reported.devs && typeof reported.devs === 'object') {
            for (const [sn, devData] of Object.entries(reported.devs)) {
                const device = this.findDeviceBySn(station, sn);
                if (device) {
                    this.applyDeviceData(device, devData);
                }
            }
            return;
        }

        // ── Variante B: Gerät-Serials als Keys (REST Shadow) ──
        for (const [key, value] of Object.entries(reported)) {
            if (typeof value !== 'object' || value === null) {
                continue;
            }

            const device = this.findDeviceBySn(station, key);
            if (device) {
                this.applyDeviceData(device, value);
            }
        }
    }

    /**
     * Sucht ein Gerät in einer Station anhand der Seriennummer.
     *
     * @param {object} station  Station-Objekt mit { devices: {} }
     * @param {string} sn       Seriennummer des gesuchten Geräts
     * @returns {object|null}   Gefundenes Device-Objekt oder null
     */
    findDeviceBySn(station, sn) {
        return Object.values(station.devices).find(d => d.serial === sn) || null;
    }

    /**
     * Wendet Gerätedaten auf ein Device-Objekt an.
     * Behandelt online-Flag, status-Substruktur, sw-Felder.
     * Quelle: python entity.py → set_data()
     *
     * @param {object} device   Device-Objekt das aktualisiert wird
     * @param {object} rawData  Rohdaten aus Shadow oder MQTT-Push
     */
    applyDeviceData(device, rawData) {
        const data = {...rawData};

        if ('online' in data) {
            device.online = data.online !== '0';
            delete data.online;
        } else if (data.onlineTime) {
            device.online = true;
        }

        const statusFields = data.status || {};
        delete data.status;

        if ('swMain' in data) {
            data.network_sw = data.sw;
            data.sw = data.swMain;
            delete data.swMain;
        }

        device.data = {...device.data, ...mapValues(device.type, {...data, ...statusFields})};

        // device.type aus device.data.type nachziehen – nur wenn device.type leer
        if (!device.type && device.data.type) {
            device.type = device.data.type;
        }
}


    // ─── Thing Shadow POST (python: do_thing, set_state) ─────────────────────

    /**
     * POSTet in ein AWS IoT Thing Shadow.
     *
     * @param {object} station  Station-Objekt mit { serial, type, house }
     * @param {string} topic    Shadow-Name / Topic für den POST
     * @param {object} data     Request-Body { state: { desired: {...} } }
     */
    async doThingShadow(station, topic, data) {
        if (this.isAwsTokenExpiring()) {
            await this.loadAws();
        }

        let typeName = station.type || '';
        if (typeName === 'SBS10') {
            typeName = '';
        }
        if (typeName === 'XC04-WX' || typeName === 'SC07-WX') {
            typeName += '-';
        }

        const host = `${station.mqttRegion}.x-sense-iot.com`;
        const uri = `/things/${typeName}${station.serial}/shadow?name=${topic}`;
        const url = `https://${host}${uri}`;
        const bodyStr = JSON.stringify(data);

        const baseHeaders = {
            'Content-Type': 'application/x-amz-json-1.0',
            'User-Agent': 'aws-sdk-iOS/2.26.5 iOS/17.3 nl_NL',
            'X-Amz-Security-Token': this.awsSessionToken,
        };

        const signedExtra = this.signer.signHeaders('POST', url, station.mqttRegion, baseHeaders, bodyStr);
        const headers = {...baseHeaders, ...signedExtra};

        const response = await fetch(url, {method: 'POST', headers, body: bodyStr});
        return await response.json();
    }

    // ─── Testalarm (python: action + set_state) ───────────────────────────────

    /**
     * Löst einen Testalarm für ein Gerät per Serial aus.
     *
     * @param {string} deviceSerial  Seriennummer des Zielgeräts
     * @returns {Promise<string>}    Statusmeldung nach erfolgreicher Ausführung
     */
    async testAlarm(deviceSerial) {
        this.log.debug(`[XSense] testAlarm für Gerät: ${deviceSerial}`);

        for (const house of Object.values(this.houses)) {
            for (const station of Object.values(house.stations)) {
                for (const device of Object.values(station.devices)) {
                    if (device.serial === deviceSerial) {
                        return await this.executeAction(station, device, 'test');
                    }
                }
            }
        }

        throw new Error(`[XSense] Gerät ${deviceSerial} nicht gefunden`);
    }

    /**
     * Führt eine Action auf einem Gerät aus.
     *
     * @param {object} station  Station-Objekt (Bridge) unter der das Gerät registriert ist
     * @param {object} device   Zielgerät mit { serial, type }
     * @param {string} action   Aktion: 'test' | 'mute' | 'firedrill'
     * @returns {Promise<string>}  Statusmeldung nach erfolgreicher Ausführung
     */
    async executeAction(station, device, action) {
        const actionDef = resolveAction(device.type, action, device);

        if (!actionDef) {
            throw new Error(`[XSense] Action '${action}' nicht unterstützt für Gerätetyp '${device.type}'`);
        }

        const now = new Date();
        const timestamp = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);

        const desired = {
            deviceSN: device.serial,
            shadow: actionDef.shadow,
            stationSN: station.serial,
            time: timestamp,
            userId: this.userId,
        };

        const body = {state: {desired}};

        await this.doThingShadow(station, actionDef.topic, body);

        return `Testalarm ausgelöst für ${device.serial}`;
    }

    /**
     * Holt den Stationszustand (Bridge-eigene Daten wie wifiRSSI, sw-Version).
     * Quelle: HA coordinator.py → get_station_state / xsense.py get_station_state
     *
     * @param {object} station  Station-Objekt dessen data-Feld befüllt wird
     */
    async getStationState(station) {
        let res = null;

        // SBS50, SC07-WX, XC04-WX: kein info_<sn> Shadow vorhanden
        if (!['SBS50', 'SC07-WX', 'XC04-WX'].includes(station.type)) {
            res = await this.getThingShadow(station, `info_${station.serial}`);
        }

        if (!res) {
            res = await this.getThingShadow(station, `2nd_info_${station.serial}`);
        }

        if (!res) {
            return;
        }

        const reported = res?.state?.reported;
        if (reported) {
            const flat = {};
            for (const [k, v] of Object.entries(reported)) {
                if (typeof v !== 'object' || v === null) {
                    flat[k] = v;
                }
            }
            station.data = {...station.data, ...mapValues(station.type, flat)};
        }
    }

    /**
     * Gibt die korrekten MQTT-Topics zurück, die für eine Station subscribed werden müssen.
     * Quelle: HA coordinator.py → assure_subscriptions()
     *
     * @param {object}  station  Station-Objekt mit { serial, houseId }
     * @returns {string[]}       Array der zu subscribenden MQTT-Topics
     */
    getMqttTopics(station) {
        return [
            `@xsense/events/+/${station.houseId}`,
            `$aws/things/${station.houseId}/shadow/name/+/update`,
            `$aws/things/${station.serial}/shadow/name/+/update`,
            `$aws/events/presence/+/${station.serial}`,
        ];
    }

    /**
     * Verarbeitet eingehende MQTT-Nachrichten und aktualisiert Gerätedaten.
     * Quelle: HA coordinator.py → async_event_received()
     *
     * Payload-Struktur: { state: { reported: { stationSN, devs:{...}, wifiRSSI, ... } } }
     *
     * @param {string}        topic    MQTT-Topic der eingehenden Nachricht
     * @param {string|Buffer} payload  Roh-Payload (JSON-String oder Buffer)
     * @returns {object|null}          Betroffene Station oder null wenn nicht verarbeitbar
     */
    processMqttMessage(topic, payload) {
        let data;
        try {
            data = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf-8'));
        } catch {
            return null;
        }

        const stationData = data?.state?.reported;
        if (!stationData) {
            return null;
        }

        // Station anhand stationSN finden
        const stationSn = stationData.stationSN;
        if (!stationSn) {
            return null;
        }

        const station = this.findStationBySn(stationSn);
        if (!station) {
            return null;
        }

        // Geräte-Daten aus devs{} extrahieren (HA: children = station_data.pop("devs",{}))
        const children = stationData.devs || {};
        const stationReported = {...stationData};
        delete stationReported.devs;
        delete stationReported.stationSN;

        // Station-eigene Felder schreiben
        this.parseReported(station, stationReported);

        // Geräte-Daten anwenden
        for (const [sn, devData] of Object.entries(children)) {
            const device = this.findDeviceBySn(station, sn);
            if (device) {
                this.applyDeviceData(device, devData);
            }
        }

        return station;
    }

    /**
     * Findet eine Station in allen Häusern anhand der Seriennummer.
     *
     * @param {string}        sn  Seriennummer der gesuchten Station
     * @returns {object|null}     Gefundenes Station-Objekt oder null
     */
    findStationBySn(sn) {
        for (const house of Object.values(this.houses)) {
            for (const station of Object.values(house.stations)) {
                if (station.serial === sn) {
                    return station;
                }
            }
        }
        return null;
    }

    /**
     * Erstellt die MQTT-Publish-Payload zum Anfordern von Live-Daten
     * für Temperatur/Luftfeuchte-Sensoren (STH51/STH0A).
     * Quelle: HA coordinator.py → request_device_updates()
     *
     * @param {object} station  Station-Objekt mit { serial, devices, house }
     * @returns {{ topic: string, payload: string }|null}  Publish-Request oder null wenn keine STH-Geräte
     */
    buildTemperatureUpdateRequest(station) {
        const updatableDevices = Object.values(station.devices)
            .filter(d => REALTIME_DEVICE_TYPES.includes(d.type))
            .map(d => d.serial);

        if (updatableDevices.length === 0) {
            return null;
        }

        const now = new Date();
        const timestamp = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);

        const payload = {
            state: {
                desired: {
                    shadow: 'appTempData',
                    deviceSN: updatableDevices,
                    source: '1',
                    report: '1',
                    reportDst: '1',
                    timeoutM: String(POLL_INTERVAL_MIN),
                    userId: this.userId,
                    time: timestamp,
                    stationSN: station.serial,
                },
            },
        };

        return {
            topic: `$aws/things/${station.serial}/shadow/name/2nd_apptempdata/update`,
            payload: JSON.stringify(payload),
        };
    }

    /**
     * Gibt die MQTT WebSocket URL zurück (python: mqtt_helper.presign_url)
     *
     * @param {object} station  Station-Objekt mit { mqttServer, mqttRegion }
     * @returns {string}        Vorzeichnete WSS-URL für den MQTT-Broker
     */
    getMqttPresignedUrl(station) {
        if (!this.signer) {
            throw new Error('[XSense] AWS Signer nicht initialisiert – loadAws() aufrufen');
        }
        return this.signer.presignUrl(
            `wss://${station.mqttServer}/mqtt`,
            station.mqttRegion,
        );
    }

    // ─── Session-Persistenz ───────────────────────────────────────────────────

    /**
     * Serialisiert die Session als JSON-String für persistente Speicherung.
     *
     * @returns {string}  JSON-String mit allen Session-Daten (Tokens, Keys, IDs)
     */
    serialize() {
        return JSON.stringify({
            clientId: this.clientId,
            clientSecretBase64: this.clientSecret ? this.clientSecret.toString('base64') : null,
            region: this.region,
            userPoolId: this.userPoolId,
            username: this.username,
            userId: this.userId,
            accessToken: this.accessToken,
            idToken: this.idToken,
            refreshToken: this.refreshToken,
            accessTokenExpiry: this.accessTokenExpiry,
            awsAccessKey: this.awsAccessKey,
            awsSecretAccessKey: this.awsSecretAccessKey,
            awsSessionToken: this.awsSessionToken,
            awsAccessExpiry: this.awsAccessExpiry,
        });
    }

    /**
     * Stellt eine Session aus einem gespeicherten JSON-String wieder her.
     *
     * @param {string}  json  Serialisierter Session-String aus serialize()
     * @param {object}  log   ioBroker Logger-Objekt { debug, info, warn, error }
     * @returns {XSenseClient}  Wiederhergestellter Client mit allen Session-Daten
     */
    static deserialize(json, log) {
        const d = JSON.parse(json);
        const client = new XSenseClient(log);

        client.clientId = d.clientId;
        client.clientSecret = d.clientSecretBase64 ? Buffer.from(d.clientSecretBase64, 'base64') : null;
        client.region = d.region;
        client.userPoolId = d.userPoolId;
        client.username = d.username;
        client.userId = d.userId;
        client.accessToken = d.accessToken;
        client.idToken = d.idToken;
        client.refreshToken = d.refreshToken;
        client.accessTokenExpiry = d.accessTokenExpiry || 0;
        client.awsAccessKey = d.awsAccessKey;
        client.awsSecretAccessKey = d.awsSecretAccessKey;
        client.awsSessionToken = d.awsSessionToken;
        client.awsAccessExpiry = d.awsAccessExpiry || 0;

        if (client.awsAccessKey && client.awsSecretAccessKey) {
            client.signer = new AWSSigner(client.awsAccessKey, client.awsSecretAccessKey, client.awsSessionToken);
        }

        return client;
    }
}

module.exports = {
    XSenseClient,
    batInfoToPercent,
    rfLevelToString,
    STATE_SIGNAL,
    DEFAULT_SCAN_INTERVAL_S,
    REALTIME_DEVICE_TYPES
};
