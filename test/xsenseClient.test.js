'use strict';

const assert = require('node:assert/strict');
const { XSenseClient, batInfoToPercent, rfLevelToString, STATE_SIGNAL, REALTIME_DEVICE_TYPES } = require('../lib/xsenseClient');

// ─── Mock-Logger ──────────────────────────────────────────────────────────────

function mockLog() {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('XSenseClient – constructor', () => {
    it('initialisiert Felder korrekt', () => {
        const c = new XSenseClient(mockLog());
        assert.equal(c.clientId,    null);
        assert.equal(c.accessToken, null);
        assert.equal(c.signer,      null);
        assert.deepEqual(c.houses, {});
    });
});

// ─── Token-Ablauf-Prüfungen ───────────────────────────────────────────────────

describe('XSenseClient – _isAccessTokenExpiring()', () => {
    it('gibt true zurück wenn kein Token vorhanden', () => {
        const c = new XSenseClient(mockLog());
        assert.equal(c._isAccessTokenExpiring(), true);
    });

    it('gibt true zurück wenn Token bereits abgelaufen', () => {
        const c = new XSenseClient(mockLog());
        c.accessToken       = 'sometoken';
        c.accessTokenExpiry = Date.now() - 1000;
        assert.equal(c._isAccessTokenExpiring(), true);
    });

    it('gibt false zurück wenn Token weit in der Zukunft abläuft', () => {
        const c = new XSenseClient(mockLog());
        c.accessToken       = 'sometoken';
        c.accessTokenExpiry = Date.now() + 10 * 60 * 1000;
        assert.equal(c._isAccessTokenExpiring(), false);
    });

    it('gibt true zurück wenn Token in weniger als 60s abläuft', () => {
        const c = new XSenseClient(mockLog());
        c.accessToken       = 'sometoken';
        c.accessTokenExpiry = Date.now() + 30 * 1000;
        assert.equal(c._isAccessTokenExpiring(), true);
    });
});

describe('XSenseClient – _isAwsTokenExpiring()', () => {
    it('gibt true zurück wenn kein AWS-Key vorhanden', () => {
        const c = new XSenseClient(mockLog());
        assert.equal(c._isAwsTokenExpiring(), true);
    });

    it('gibt false zurück wenn AWS-Key weit in der Zukunft abläuft', () => {
        const c = new XSenseClient(mockLog());
        c.awsAccessKey    = 'AKIATEST';
        c.awsAccessExpiry = Date.now() + 10 * 60 * 1000;
        assert.equal(c._isAwsTokenExpiring(), false);
    });
});

// ─── _decodeSecret ───────────────────────────────────────────────────────────

describe('XSenseClient – _decodeSecret()', () => {
    it('entfernt 4 führende und 1 abschliessendes Byte', () => {
        const c = new XSenseClient(mockLog());
        const raw     = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const encoded = raw.toString('base64');
        const result  = c._decodeSecret(encoded);
        assert.deepEqual(result, Buffer.from([4, 5, 6, 7, 8]));
    });

    it('gibt einen Buffer zurück', () => {
        const c = new XSenseClient(mockLog());
        const result = c._decodeSecret(Buffer.from('testdataabc').toString('base64'));
        assert.ok(Buffer.isBuffer(result));
    });
});

// ─── _calculateMac ───────────────────────────────────────────────────────────

describe('XSenseClient – _calculateMac()', () => {
    function makeClientWithSecret(secretBytes) {
        const c = new XSenseClient(mockLog());
        c.clientSecret = Buffer.from(secretBytes);
        return c;
    }

    it('gibt einen MD5-Hex-String zurück (32 Zeichen)', () => {
        const c      = makeClientWithSecret('mysecret');
        const result = c._calculateMac({ key: 'value' });
        assert.match(result, /^[0-9a-f]{32}$/);
    });

    it('ist deterministisch', () => {
        const c = makeClientWithSecret('mysecret');
        assert.equal(c._calculateMac({ a: '1', b: '2' }), c._calculateMac({ a: '1', b: '2' }));
    });

    it('unterscheidet sich bei verschiedenen Daten', () => {
        const c = makeClientWithSecret('mysecret');
        assert.notEqual(c._calculateMac({ a: '1' }), c._calculateMac({ a: '2' }));
    });

    it('verarbeitet Arrays korrekt', () => {
        const c = makeClientWithSecret('s');
        assert.doesNotThrow(() => c._calculateMac({ list: ['a', 'b', 'c'] }));
    });

    it('verarbeitet verschachtelte Objekte', () => {
        const c = makeClientWithSecret('s');
        assert.doesNotThrow(() => c._calculateMac({ obj: { nested: true } }));
    });
});

// ─── Serialisierung / Deserialisierung ────────────────────────────────────────

describe('XSenseClient – serialize() / deserialize()', () => {
    function populatedClient() {
        const c = new XSenseClient(mockLog());
        c.clientId           = 'myClientId';
        c.clientSecret       = Buffer.from('supersecret');
        c.region             = 'eu-west-1';
        c.userPoolId         = 'eu-west-1_ABCD1234';
        c.username           = 'test@example.com';
        c.userId             = 'user-uuid-123';
        c.accessToken        = 'ACCESS_TOKEN';
        c.idToken            = 'ID_TOKEN';
        c.refreshToken       = 'REFRESH_TOKEN';
        c.accessTokenExpiry  = Date.now() + 3600_000;
        c.awsAccessKey       = 'AKIATEST';
        c.awsSecretAccessKey = 'AWSSECRET';
        c.awsSessionToken    = 'AWSTOKEN';
        c.awsAccessExpiry    = Date.now() + 3600_000;
        return c;
    }

    it('serialize() gibt validen JSON-String zurück', () => {
        assert.doesNotThrow(() => JSON.parse(populatedClient().serialize()));
    });

    it('deserialize() stellt alle Felder korrekt wieder her', () => {
        const original = populatedClient();
        const restored = XSenseClient.deserialize(original.serialize(), mockLog());
        assert.equal(restored.clientId,    original.clientId);
        assert.equal(restored.region,      original.region);
        assert.equal(restored.username,    original.username);
        assert.equal(restored.accessToken, original.accessToken);
        assert.equal(restored.refreshToken, original.refreshToken);
        assert.equal(restored.awsAccessKey, original.awsAccessKey);
    });

    it('clientSecret wird als Buffer wiederhergestellt', () => {
        const original = populatedClient();
        const restored = XSenseClient.deserialize(original.serialize(), mockLog());
        assert.ok(Buffer.isBuffer(restored.clientSecret));
        assert.deepEqual(restored.clientSecret, original.clientSecret);
    });

    it('signer wird nach Deserialisierung befüllt', () => {
        const restored = XSenseClient.deserialize(populatedClient().serialize(), mockLog());
        assert.ok(restored.signer !== null);
    });

    it('Deserialisierung schlägt auf ungültigem JSON fehl', () => {
        assert.throws(() => XSenseClient.deserialize('not-json', mockLog()));
    });
});

// ─── _parseReported ──────────────────────────────────────────────────────────

describe('XSenseClient – _parseReported()', () => {
    function makeStation(devices = {}) {
        return {
            serial: 'BRIDGE001',
            type:   'SBS50',
            data:   {},
            house:  { mqttRegion: 'eu-west-1' },
            devices,
        };
    }

    it('schreibt flache Station-Werte in station.data', () => {
        const c       = new XSenseClient(mockLog());
        const station = makeStation();
        c._parseReported(station, { wifiRssi: '-55', batInfo: '3' });
        assert.equal(station.data.wifiRSSI, -55);
        assert.equal(station.data.batInfo,  3);
    });

    it('befüllt device.data anhand der Serial (Variante B – REST Shadow)', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: true, data: {} };
        const station = makeStation({ d1: device });
        c._parseReported(station, { DEV001: { batInfo: '2', alarmStatus: '1' } });
        assert.equal(device.data.batInfo,     2);
        assert.equal(device.data.alarmStatus, true);
    });

    it('befüllt device.data aus devs{} (Variante A – MQTT-Push, HA-Struktur)', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: true, data: {} };
        const station = makeStation({ d1: device });
        c._parseReported(station, {
            stationSN: 'BRIDGE001',
            devs: { DEV001: { batInfo: '2', alarmStatus: '0' } },
        });
        assert.equal(device.data.batInfo,     2);
        assert.equal(device.data.alarmStatus, false);
    });

    it('setzt device.online auf false wenn online === "0"', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: true, data: {} };
        const station = makeStation({ d1: device });
        c._parseReported(station, { DEV001: { online: '0', batInfo: '1' } });
        assert.equal(device.online, false);
    });

    it('setzt device.online auf true wenn onlineTime vorhanden', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: false, data: {} };
        const station = makeStation({ d1: device });
        c._parseReported(station, { DEV001: { onlineTime: '1710000000', batInfo: '1' } });
        assert.equal(device.online, true);
    });
});

// ─── processMqttMessage ───────────────────────────────────────────────────────

describe('XSenseClient – processMqttMessage()', () => {
    function makeClientWithStation() {
        const c = new XSenseClient(mockLog());
        const device  = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: true, data: {} };
        const station = {
            serial: 'BRIDGE001', type: 'SBS50', data: {},
            house:  { houseId: 'HOUSE01', mqttRegion: 'eu-west-1' },
            devices: { d1: device },
        };
        c.houses = { HOUSE01: { houseId: 'HOUSE01', stations: { s1: station } } };
        return { c, station, device };
    }

    it('gibt null zurück bei ungültigem JSON', () => {
        const { c } = makeClientWithStation();
        assert.equal(c.processMqttMessage('topic', 'invalid-json'), null);
    });

    it('gibt null zurück wenn kein stationSN', () => {
        const { c } = makeClientWithStation();
        const payload = JSON.stringify({ state: { reported: { batInfo: '2' } } });
        assert.equal(c.processMqttMessage('$aws/things/BRIDGE001/shadow/name/x/update', payload), null);
    });

    it('gibt Station zurück bei korrekter Payload', () => {
        const { c, station } = makeClientWithStation();
        const payload = JSON.stringify({
            state: { reported: { stationSN: 'BRIDGE001', devs: { DEV001: { batInfo: '2' } } } }
        });
        const result = c.processMqttMessage('$aws/things/BRIDGE001/shadow/name/x/update', payload);
        assert.ok(result !== null, 'Sollte die Station zurückgeben');
        assert.equal(result.serial, 'BRIDGE001');
    });

    it('aktualisiert device.data via devs{}', () => {
        const { c, device } = makeClientWithStation();
        const payload = JSON.stringify({
            state: { reported: { stationSN: 'BRIDGE001', devs: { DEV001: { batInfo: '3', alarmStatus: '1' } } } }
        });
        c.processMqttMessage('topic', payload);
        assert.equal(device.data.batInfo,     3);
        assert.equal(device.data.alarmStatus, true);
    });
});

// ─── getMqttTopics ────────────────────────────────────────────────────────────

describe('XSenseClient – getMqttTopics()', () => {
    it('gibt 4 Topics zurück', () => {
        const c = new XSenseClient(mockLog());
        const house   = { houseId: 'HOUSE01' };
        const station = { serial: 'BRIDGE001' };
        const topics  = c.getMqttTopics(house, station);
        assert.equal(topics.length, 4);
    });

    it('enthält presence-Topic', () => {
        const c = new XSenseClient(mockLog());
        const topics = c.getMqttTopics({ houseId: 'H1' }, { serial: 'S1' });
        assert.ok(topics.some(t => t.includes('presence')));
    });

    it('enthält shadow update-Topic für Station', () => {
        const c = new XSenseClient(mockLog());
        const topics = c.getMqttTopics({ houseId: 'H1' }, { serial: 'S1' });
        assert.ok(topics.some(t => t.includes('S1') && t.includes('shadow')));
    });
});

// ─── buildTemperatureUpdateRequest ───────────────────────────────────────────

describe('XSenseClient – buildTemperatureUpdateRequest()', () => {
    it('gibt null zurück wenn keine STH-Geräte vorhanden', () => {
        const c = new XSenseClient(mockLog());
        const station = { serial: 'S1', devices: {
            d1: { serial: 'DEV1', type: 'XS01-M' },
        }};
        assert.equal(c.buildTemperatureUpdateRequest(station), null);
    });

    it('gibt topic + payload zurück wenn STH0A vorhanden', () => {
        const c = new XSenseClient(mockLog());
        c.userId = 'user123';
        const station = { serial: 'S1', devices: {
            d1: { serial: 'DEV1', type: 'STH0A' },
        }};
        const req = c.buildTemperatureUpdateRequest(station);
        assert.ok(req !== null);
        assert.ok(req.topic.includes('S1'));
        assert.ok(req.topic.includes('2nd_apptempdata'));
    });

    it('payload enthält alle erforderlichen HA-Felder', () => {
        const c = new XSenseClient(mockLog());
        c.userId = 'user123';
        const station = { serial: 'S1', devices: { d1: { serial: 'DEV1', type: 'STH51' } } };
        const req     = c.buildTemperatureUpdateRequest(station);
        const payload = JSON.parse(req.payload);
        const desired = payload.state.desired;
        assert.ok(Array.isArray(desired.deviceSN));
        assert.equal(desired.shadow,     'appTempData');
        assert.equal(desired.stationSN,  'S1');
        assert.equal(desired.report,     '1');
        assert.ok(desired.timeoutM);
    });

    it('enthält mehrere Serials wenn mehrere STH-Geräte vorhanden', () => {
        const c = new XSenseClient(mockLog());
        c.userId = 'u1';
        const station = { serial: 'S1', devices: {
            d1: { serial: 'DEV1', type: 'STH0A' },
            d2: { serial: 'DEV2', type: 'STH51' },
        }};
        const req     = c.buildTemperatureUpdateRequest(station);
        const payload = JSON.parse(req.payload);
        assert.equal(payload.state.desired.deviceSN.length, 2);
    });
});

// ─── batInfoToPercent / rfLevelToString ──────────────────────────────────────

describe('batInfoToPercent()', () => {
    it('0 → 0%',   () => assert.equal(batInfoToPercent(0), 0));
    it('1 → 33%',  () => assert.equal(batInfoToPercent(1), 33));
    it('2 → 67%',  () => assert.equal(batInfoToPercent(2), 67));
    it('3 → 100%', () => assert.equal(batInfoToPercent(3), 100));
});

describe('rfLevelToString()', () => {
    it('0 → no_signal', () => assert.equal(rfLevelToString(0), 'no_signal'));
    it('1 → weak',      () => assert.equal(rfLevelToString(1), 'weak'));
    it('2 → moderate',  () => assert.equal(rfLevelToString(2), 'moderate'));
    it('3 → good',      () => assert.equal(rfLevelToString(3), 'good'));
    it('string "2" → moderate', () => assert.equal(rfLevelToString('2'), 'moderate'));
    it('unbekannter Wert → no_signal', () => assert.equal(rfLevelToString(99), 'no_signal'));
});

describe('STATE_SIGNAL Konstante', () => {
    it('hat 4 Einträge', () => assert.equal(STATE_SIGNAL.length, 4));
    it('entspricht HA const.py', () => assert.deepEqual(STATE_SIGNAL, ['no_signal', 'weak', 'moderate', 'good']));
});

describe('REALTIME_DEVICE_TYPES', () => {
    it('enthält STH51 und STH0A', () => {
        assert.ok(REALTIME_DEVICE_TYPES.includes('STH51'));
        assert.ok(REALTIME_DEVICE_TYPES.includes('STH0A'));
    });
});


// ─── Mock-Logger ──────────────────────────────────────────────────────────────

function mockLog() {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('XSenseClient – constructor', () => {
    it('initialisiert Felder korrekt', () => {
        const c = new XSenseClient(mockLog());
        assert.equal(c.clientId,    null);
        assert.equal(c.accessToken, null);
        assert.equal(c.signer,      null);
        assert.deepEqual(c.houses, {});
    });
});

// ─── Token-Ablauf-Prüfungen ───────────────────────────────────────────────────

describe('XSenseClient – _isAccessTokenExpiring()', () => {
    it('gibt true zurück wenn kein Token vorhanden', () => {
        const c = new XSenseClient(mockLog());
        assert.equal(c._isAccessTokenExpiring(), true);
    });

    it('gibt true zurück wenn Token bereits abgelaufen', () => {
        const c = new XSenseClient(mockLog());
        c.accessToken       = 'sometoken';
        c.accessTokenExpiry = Date.now() - 1000; // in der Vergangenheit
        assert.equal(c._isAccessTokenExpiring(), true);
    });

    it('gibt false zurück wenn Token weit in der Zukunft abläuft', () => {
        const c = new XSenseClient(mockLog());
        c.accessToken       = 'sometoken';
        c.accessTokenExpiry = Date.now() + 10 * 60 * 1000; // +10 Minuten
        assert.equal(c._isAccessTokenExpiring(), false);
    });

    it('gibt true zurück wenn Token in weniger als 60s abläuft', () => {
        const c = new XSenseClient(mockLog());
        c.accessToken       = 'sometoken';
        c.accessTokenExpiry = Date.now() + 30 * 1000; // +30 Sekunden
        assert.equal(c._isAccessTokenExpiring(), true);
    });
});

describe('XSenseClient – _isAwsTokenExpiring()', () => {
    it('gibt true zurück wenn kein AWS-Key vorhanden', () => {
        const c = new XSenseClient(mockLog());
        assert.equal(c._isAwsTokenExpiring(), true);
    });

    it('gibt false zurück wenn AWS-Key weit in der Zukunft abläuft', () => {
        const c = new XSenseClient(mockLog());
        c.awsAccessKey    = 'AKIATEST';
        c.awsAccessExpiry = Date.now() + 10 * 60 * 1000;
        assert.equal(c._isAwsTokenExpiring(), false);
    });
});

// ─── _decodeSecret ───────────────────────────────────────────────────────────

describe('XSenseClient – _decodeSecret()', () => {
    it('entfernt 4 führende und 1 abschliessendes Byte', () => {
        const c = new XSenseClient(mockLog());
        // Erstelle 10-Byte Payload [0,1,2,3, 4,5,6,7,8, 9]
        const raw     = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const encoded = raw.toString('base64');
        const result  = c._decodeSecret(encoded);
        // Erwartet: Bytes 4..8 (5 Bytes)
        assert.deepEqual(result, Buffer.from([4, 5, 6, 7, 8]));
    });

    it('gibt einen Buffer zurück', () => {
        const c = new XSenseClient(mockLog());
        const raw = Buffer.from('testdataabc');
        const result = c._decodeSecret(raw.toString('base64'));
        assert.ok(Buffer.isBuffer(result));
    });
});

// ─── _calculateMac ───────────────────────────────────────────────────────────

describe('XSenseClient – _calculateMac()', () => {
    function makeClientWithSecret(secretBytes) {
        const c = new XSenseClient(mockLog());
        c.clientSecret = Buffer.from(secretBytes);
        return c;
    }

    it('gibt einen MD5-Hex-String zurück (32 Zeichen)', () => {
        const c      = makeClientWithSecret('mysecret');
        const result = c._calculateMac({ key: 'value' });
        assert.match(result, /^[0-9a-f]{32}$/);
    });

    it('ist deterministisch', () => {
        const c = makeClientWithSecret('mysecret');
        assert.equal(
            c._calculateMac({ a: '1', b: '2' }),
            c._calculateMac({ a: '1', b: '2' }),
        );
    });

    it('unterscheidet sich bei verschiedenen Daten', () => {
        const c = makeClientWithSecret('mysecret');
        assert.notEqual(
            c._calculateMac({ a: '1' }),
            c._calculateMac({ a: '2' }),
        );
    });

    it('verarbeitet Arrays korrekt', () => {
        const c = makeClientWithSecret('s');
        assert.doesNotThrow(() => c._calculateMac({ list: ['a', 'b', 'c'] }));
    });

    it('verarbeitet verschachtelte Objekte', () => {
        const c = makeClientWithSecret('s');
        assert.doesNotThrow(() => c._calculateMac({ obj: { nested: true } }));
    });

    it('verarbeitet leere Daten', () => {
        const c = makeClientWithSecret('s');
        assert.doesNotThrow(() => c._calculateMac({}));
    });
});

// ─── Serialisierung / Deserialisierung ────────────────────────────────────────

describe('XSenseClient – serialize() / deserialize()', () => {
    function populatedClient() {
        const c = new XSenseClient(mockLog());
        c.clientId           = 'myClientId';
        c.clientSecret       = Buffer.from('supersecret');
        c.region             = 'eu-west-1';
        c.userPoolId         = 'eu-west-1_ABCD1234';
        c.username           = 'test@example.com';
        c.userId             = 'user-uuid-123';
        c.accessToken        = 'ACCESS_TOKEN';
        c.idToken            = 'ID_TOKEN';
        c.refreshToken       = 'REFRESH_TOKEN';
        c.accessTokenExpiry  = Date.now() + 3600_000;
        c.awsAccessKey       = 'AKIATEST';
        c.awsSecretAccessKey = 'AWSSECRET';
        c.awsSessionToken    = 'AWSTOKEN';
        c.awsAccessExpiry    = Date.now() + 3600_000;
        return c;
    }

    it('serialize() gibt validen JSON-String zurück', () => {
        const json = populatedClient().serialize();
        assert.doesNotThrow(() => JSON.parse(json));
    });

    it('deserialize() stellt alle Felder korrekt wieder her', () => {
        const original = populatedClient();
        const json     = original.serialize();
        const restored = XSenseClient.deserialize(json, mockLog());

        assert.equal(restored.clientId,    original.clientId);
        assert.equal(restored.region,      original.region);
        assert.equal(restored.username,    original.username);
        assert.equal(restored.accessToken, original.accessToken);
        assert.equal(restored.refreshToken, original.refreshToken);
        assert.equal(restored.awsAccessKey, original.awsAccessKey);
    });

    it('clientSecret wird als Buffer wiederhergestellt', () => {
        const original = populatedClient();
        const restored = XSenseClient.deserialize(original.serialize(), mockLog());
        assert.ok(Buffer.isBuffer(restored.clientSecret));
        assert.deepEqual(restored.clientSecret, original.clientSecret);
    });

    it('signer wird nach Deserialisierung mit AWS-Credentials befüllt', () => {
        const original = populatedClient();
        const restored = XSenseClient.deserialize(original.serialize(), mockLog());
        assert.ok(restored.signer !== null, 'signer sollte nicht null sein');
    });

    it('Deserialisierung schlägt auf ungültigem JSON fehl', () => {
        assert.throws(() => XSenseClient.deserialize('not-json', mockLog()));
    });
});

// ─── mapValues (interner test via _parseReported) ────────────────────────────

describe('XSenseClient – _parseReported()', () => {
    function makeStation(devices = {}) {
        return {
            serial: 'BRIDGE001',
            type:   'SBS50',
            data:   {},
            house:  { mqttRegion: 'eu-west-1' },
            devices,
        };
    }

    it('schreibt flache Station-Werte in station.data', () => {
        const c       = new XSenseClient(mockLog());
        const station = makeStation();
        c._parseReported(station, { wifiRssi: '-55', batInfo: '3' });

        // wifiRssi → wifiRSSI (mapped) und als number
        assert.equal(station.data.wifiRSSI, -55);
        assert.equal(station.data.batInfo,  3);
    });

    it('befüllt device.data anhand der Serial', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: true, data: {} };
        const station = makeStation({ d1: device });

        c._parseReported(station, {
            DEV001: { batInfo: '2', alarmStatus: '1' },
        });

        assert.equal(device.data.batInfo,     2);
        assert.equal(device.data.alarmStatus, true);
    });

    it('setzt device.online auf false wenn online === "0"', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: true, data: {} };
        const station = makeStation({ d1: device });

        c._parseReported(station, { DEV001: { online: '0', batInfo: '1' } });
        assert.equal(device.online, false);
    });

    it('setzt device.online auf true wenn onlineTime vorhanden', () => {
        const c      = new XSenseClient(mockLog());
        const device = { deviceId: 'd1', serial: 'DEV001', type: 'XS01-M', online: false, data: {} };
        const station = makeStation({ d1: device });

        c._parseReported(station, { DEV001: { onlineTime: '1710000000', batInfo: '1' } });
        assert.equal(device.online, true);
    });
});
