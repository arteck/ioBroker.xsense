'use strict';

/**
 * Tests für die vollständige HA MQTT Discovery Topic-Pipeline.
 *
 * Echte Topics aus dem MQTT-Log (XH02-M Heat Alarm SBS5015298924_00000009):
 *   homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state
 *   homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_online/state
 *   homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_lifeend/state
 *   homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatalarm/state
 *   homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatfault/state
 */

const assert = require('node:assert/strict');
const { batInfoToPercent } = require('../lib/xsenseClient');

// ─────────────────────────────────────────────────────────────────────────────
// Extrahierte Kernlogik aus main.js (Unit-testbar ohne ioBroker-Adapter)
// ─────────────────────────────────────────────────────────────────────────────

/** Letztes Segment eines Topics */
function getTopicSuffix(topic) {
    if (typeof topic !== 'string' || topic.length === 0) return null;
    const parts = topic.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Baut newMessage-JSON wie in mqttClient.on('message') – nur erstes Segment abschneiden.
 * topic = "homeassistant/binary_sensor/..." → suffix = "binary_sensor/..."
 */
function buildNewMessage(rawTopic, rawPayload) {
    const payloadStr = rawPayload.toString();
    const slashIdx   = rawTopic.indexOf('/');
    const topicSuffix = slashIdx >= 0 ? rawTopic.slice(slashIdx + 1) : rawTopic;

    let payloadJson;
    if (payloadStr === '') {
        payloadJson = '"null"';
    } else {
        try {
            JSON.parse(payloadStr);
            payloadJson = payloadStr;
        } catch {
            payloadJson = JSON.stringify(payloadStr);
        }
    }
    return `{"payload":${payloadJson},"topic":"${topicSuffix}"}`;
}

/**
 * Parst bridgeId / deviceId / attribute aus dem vorletzten Segment.
 * Eingabe topic ist bereits das aus newMessage extrahierte (ohne erstes Segment).
 */
function parseTopicParts(topic) {
    const parts   = topic.split('/').filter(Boolean);
    const findDp  = parts.at(-2) ?? '';
    const mTopic  = findDp.match(/^SBS50([^_]+)_([^_]+)_(.+)$/);
    return {
        bridgeId:  mTopic?.[1] ?? null,
        deviceId:  mTopic?.[2] ?? null,
        attribute: mTopic?.[3] ?? null,
    };
}

/**
 * Payload-Status extrahieren – sowohl aus JSON-Objekt als auch aus String.
 */
function getStatus(payload) {
    if (payload !== null && typeof payload === 'object') return payload.status;
    return String(payload ?? '');
}

/**
 * Minimal-Adapter-Mock: zeichnet setState-Aufrufe auf.
 */
function createAdapterMock(houses = {}) {
    const states = {};
    return {
        states,
        FORBIDDEN_CHARS: /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu,
        xsenseClient: { houses },
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        setState(id, valOrObj) {
            states[id] = typeof valOrObj === 'object' && 'val' in valOrObj ? valOrObj.val : valOrObj;
        },
        async setObjectNotExistsAsync() {},
        _resolveDevicePath(bridgeSerial, deviceSerial) {
            const xc = this.xsenseClient;
            if (xc?.houses) {
                // bridgeSerial = "15298924" (Regex schneidet SBS50 ab)
                // station.serial aus API = "15298924" (OHNE SBS50-Prefix) → direkter Vergleich
                for (const house of Object.values(xc.houses)) {
                    for (const station of Object.values(house.stations)) {
                        if (station.serial === bridgeSerial) {
                            const houseName = (house.name || house.houseId)
                                .replace(/\s+/g, '_')
                                .replace(/\./g, '_')
                                .replace(this.FORBIDDEN_CHARS, '_');
                            return `devices.${houseName}.${bridgeSerial}.${deviceSerial}`;
                        }
                    }
                }
            }
            return `devices.${bridgeSerial}.${deviceSerial}`;
        },
    };
}

/** Führt die messageParse-switch-Logik aus (ohne Mutex, ohne ioBroker). */
async function runMessageParse(adapter, messageJson) {
    const messageObj = JSON.parse(messageJson);

    if (!messageObj.topic.includes('SBS50'))             return { skipped: 'no SBS50' };
    const suffix = getTopicSuffix(messageObj.topic);
    if (suffix !== 'state')                              return { skipped: `suffix=${suffix}` };

    const { bridgeId, deviceId, attribute } = parseTopicParts(messageObj.topic);
    if (!bridgeId || !deviceId || !attribute)            return { skipped: 'parse fail' };

    const devicePath = adapter._resolveDevicePath(bridgeId, deviceId);
    const status     = getStatus(messageObj.payload);

    switch (attribute) {
        case 'battery': {
            const batLevel =
                status === 'Normal'   ? 3 :
                status === 'Low'      ? 2 :
                status === 'Critical' ? 1 : 0;
            adapter.setState(`${devicePath}.batInfo`, { val: batInfoToPercent(batLevel), ack: true });
            break;
        }
        case 'lifeend':
            adapter.setState(`${devicePath}.isLifeEnd`, { val: status === 'EOL', ack: true });
            break;
        case 'online':
            adapter.setState(`${devicePath}.online`, { val: status === 'Online', ack: true });
            break;
        case 'smokealarm':
        case 'heatalarm':
        case 'coalarm':
            adapter.setState(`${devicePath}.alarmStatus`, { val: status === 'Detected', ack: true });
            break;
        case 'smokefault':
        case 'heatfault':
        case 'cofault':
            adapter.setState(`${devicePath}.faultStatus`, { val: status === 'Fault', ack: true });
            break;
        default:
            return { skipped: `unknown attribute=${attribute}` };
    }

    return { devicePath, attribute, status };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hilfsfunktion: echte HA-Topic-Pipeline von Anfang bis Ende
// ─────────────────────────────────────────────────────────────────────────────

async function pipelineHA(adapter, rawTopic, rawPayload) {
    const newMessage = buildNewMessage(rawTopic, rawPayload);
    return runMessageParse(adapter, newMessage);
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard-Haus-Struktur (entspricht den echten Daten)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_HOUSES = {
    house1: {
        houseId: 'house1',
        name: 'home',
        stations: {
            // station.serial kommt von API als "15298924" (OHNE SBS50-Prefix)
            st1: { serial: '15298924', stationId: 'st1', devices: {} },
        },
    },
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. buildNewMessage – HA-Topic-Prefix wird korrekt abgeschnitten
// ═════════════════════════════════════════════════════════════════════════════
describe('buildNewMessage – HA MQTT Discovery Topics', () => {

    it('schneidet nur das erste Segment (homeassistant) ab', () => {
        const raw = 'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state';
        const msg = JSON.parse(buildNewMessage(raw, '{ "status": "Normal"}'));
        assert.equal(
            msg.topic,
            'binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state',
        );
    });

    it('parst JSON-Objekt-Payload korrekt', () => {
        const msg = JSON.parse(buildNewMessage(
            'homeassistant/binary_sensor/X/Y/state',
            '{ "status": "Online"}',
        ));
        assert.deepEqual(msg.payload, { status: 'Online' });
    });

    it('hüllt Plain-String in JSON ein (kein Object-Payload)', () => {
        const msg = JSON.parse(buildNewMessage('homeassistant/a/b/c/state', 'Normal'));
        assert.equal(msg.payload, 'Normal');
    });

    it('ersetzt leeren Payload durch "null"', () => {
        const msg = JSON.parse(buildNewMessage('homeassistant/a/b/state', ''));
        assert.equal(msg.payload, 'null');
    });

    it('gibt gültiges JSON für config-Topic mit großem Payload zurück', () => {
        const configPayload = JSON.stringify({
            name: 'Battery Status',
            unique_id: 'SBS5015298924_00000009_battery',
            state_topic: 'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state',
            device_class: 'battery',
            payload_on: 'Low',
            payload_off: 'Normal',
            value_template: '{{ value_json.status }}',
            qos: 1,
            retain: true,
            device: {
                identifiers: ['SBS5015298924_00000009'],
                name: 'Heat Alarm(SBS5015298924_00000009)',
                manufacturer: 'X-SENSE',
                model: 'XH02-M',
                sw_version: 'v2.8.0',
            },
        });
        assert.doesNotThrow(() => JSON.parse(buildNewMessage(
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/config',
            configPayload,
        )));
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Regex – SBS5015298924_00000009_<attr>  →  bridgeId / deviceId / attribute
// ═════════════════════════════════════════════════════════════════════════════
describe('parseTopicParts – echte HA-Topic-Segmente', () => {

    // Topic aus buildNewMessage hat 4 Segmente:
    // binary_sensor / SBS5015298924_00000009 / SBS5015298924_00000009_battery / state
    // parts.at(-2) = SBS5015298924_00000009_battery

    const CASES = [
        { segment: 'SBS5015298924_00000009_battery',   bridgeId: '15298924', deviceId: '00000009', attribute: 'battery'   },
        { segment: 'SBS5015298924_00000009_online',    bridgeId: '15298924', deviceId: '00000009', attribute: 'online'    },
        { segment: 'SBS5015298924_00000009_lifeend',   bridgeId: '15298924', deviceId: '00000009', attribute: 'lifeend'   },
        { segment: 'SBS5015298924_00000009_heatalarm', bridgeId: '15298924', deviceId: '00000009', attribute: 'heatalarm' },
        { segment: 'SBS5015298924_00000009_heatfault', bridgeId: '15298924', deviceId: '00000009', attribute: 'heatfault' },
    ];

    for (const { segment, bridgeId, deviceId, attribute } of CASES) {
        it(`parst "${segment}" korrekt`, () => {
            // Baue ein "echtes" multi-Segment-Topic
            const topic = `binary_sensor/SBS5015298924_00000009/${segment}/state`;
            const result = parseTopicParts(topic);
            assert.equal(result.bridgeId,  bridgeId,  `bridgeId für ${segment}`);
            assert.equal(result.deviceId,  deviceId,  `deviceId für ${segment}`);
            assert.equal(result.attribute, attribute, `attribute für ${segment}`);
        });
    }

    it('gibt null-Felder zurück für Non-SBS50-Segment', () => {
        const result = parseTopicParts('binary_sensor/OtherDevice/OtherDevice_battery/state');
        assert.equal(result.bridgeId, null);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. getStatus – JSON-Objekt vs. String
// ═════════════════════════════════════════════════════════════════════════════
describe('getStatus()', () => {
    it('extrahiert status aus JSON-Objekt  { status: "Normal" }', () => {
        assert.equal(getStatus({ status: 'Normal' }), 'Normal');
    });
    it('extrahiert status aus JSON-Objekt  { status: "Online" }', () => {
        assert.equal(getStatus({ status: 'Online' }), 'Online');
    });
    it('extrahiert status aus JSON-Objekt  { status: "Cleared" }', () => {
        assert.equal(getStatus({ status: 'Cleared' }), 'Cleared');
    });
    it('gibt String direkt zurück wenn kein Objekt', () => {
        assert.equal(getStatus('Normal'), 'Normal');
    });
    it('gibt "" für null zurück (null ?? "" → String("") = "")', () => {
        assert.equal(getStatus(null), '');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. _resolveDevicePath – Haus-Ordner-Auflösung
// ═════════════════════════════════════════════════════════════════════════════
describe('_resolveDevicePath()', () => {

    it('findet Haus-Ordner wenn station.serial übereinstimmt', () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        const path = adapter._resolveDevicePath('15298924', '00000009');
        assert.equal(path, 'devices.home.15298924.00000009');
    });

    it('Fallback auf devices.<bridge>.<device> wenn Station nicht gefunden', () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        const path = adapter._resolveDevicePath('UNBEKANNT', '00000009');
        assert.equal(path, 'devices.UNBEKANNT.00000009');
    });

    it('bereinigt Leerzeichen im Hausnamen', () => {
        const houses = {
            h1: {
                houseId: 'h1',
                name: 'Mein Zuhause',
                stations: { s1: { serial: '15298924', stationId: 's1', devices: {} } },
            },
        };
        const adapter = createAdapterMock(houses);
        const path = adapter._resolveDevicePath('15298924', '00000009');
        assert.equal(path, 'devices.Mein_Zuhause.15298924.00000009');
    });

    it('bereinigt Punkte im Hausnamen', () => {
        const houses = {
            h1: {
                houseId: 'h1',
                name: 'Haus.EG',
                stations: { s1: { serial: '15298924', stationId: 's1', devices: {} } },
            },
        };
        const adapter = createAdapterMock(houses);
        const path = adapter._resolveDevicePath('15298924', '00000009');
        assert.equal(path, 'devices.Haus_EG.15298924.00000009');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Vollständige Pipeline – echte MQTT-Topics aus dem Log
// ═════════════════════════════════════════════════════════════════════════════
describe('Vollständige HA-Topic-Pipeline (echte Log-Daten)', () => {

    // ── battery ──────────────────────────────────────────────────────────────

    it('[battery] Normal → batInfo = 100%', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state',
            '{ "status": "Normal"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.batInfo'], 100);
    });

    it('[battery] Low → batInfo = 67%', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state',
            '{ "status": "Low"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.batInfo'], 67);
    });

    it('[battery] Critical → batInfo = 33%', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state',
            '{ "status": "Critical"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.batInfo'], 33);
    });

    // ── online ────────────────────────────────────────────────────────────────

    it('[online] Online → online = true', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_online/state',
            '{ "status": "Online"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.online'], true);
    });

    it('[online] Offline → online = false', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_online/state',
            '{ "status": "Offline"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.online'], false);
    });

    // ── lifeend ───────────────────────────────────────────────────────────────

    it('[lifeend] Normal → isLifeEnd = false', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_lifeend/state',
            '{ "status": "Normal"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.isLifeEnd'], false);
    });

    it('[lifeend] EOL → isLifeEnd = true', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_lifeend/state',
            '{ "status": "EOL"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.isLifeEnd'], true);
    });

    // ── heatalarm ─────────────────────────────────────────────────────────────

    it('[heatalarm] Cleared → alarmStatus = false', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatalarm/state',
            '{ "status": "Cleared"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.alarmStatus'], false);
    });

    it('[heatalarm] Detected → alarmStatus = true', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatalarm/state',
            '{ "status": "Detected"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.alarmStatus'], true);
    });

    // ── heatfault ─────────────────────────────────────────────────────────────

    it('[heatfault] Normal → faultStatus = false', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatfault/state',
            '{ "status": "Normal"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.faultStatus'], false);
    });

    it('[heatfault] Fault → faultStatus = true', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatfault/state',
            '{ "status": "Fault"}');
        assert.equal(adapter.states['devices.home.15298924.00000009.faultStatus'], true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Config-Topics werden ignoriert
// ═════════════════════════════════════════════════════════════════════════════
describe('Config-Topics werden ignoriert', () => {

    const CONFIG_TOPICS = [
        'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_online/config',
        'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/config',
        'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_lifeend/config',
        'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatalarm/config',
        'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_heatfault/config',
    ];

    const configPayload = JSON.stringify({ name: 'x', state_topic: 'y/state' });

    for (const topic of CONFIG_TOPICS) {
        it(`ignoriert config-Topic: ${topic.split('/').pop()}`, async () => {
            const adapter = createAdapterMock(DEFAULT_HOUSES);
            const result = await pipelineHA(adapter, topic, configPayload);
            assert.equal(result.skipped, 'suffix=config', `${topic} sollte übersprungen werden`);
            assert.equal(Object.keys(adapter.states).length, 0, 'Kein setState bei config-Topic');
        });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Edge Cases
// ═════════════════════════════════════════════════════════════════════════════
describe('Edge Cases', () => {

    it('Non-SBS50-Topic wird nicht verarbeitet', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        const result = await pipelineHA(
            adapter,
            'homeassistant/binary_sensor/ZigbeeDevice/ZigbeeDevice_battery/state',
            '{ "status": "Normal"}',
        );
        assert.equal(result.skipped, 'no SBS50');
        assert.equal(Object.keys(adapter.states).length, 0);
    });

    it('Unbekanntes Attribut wird übersprungen', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        const result = await pipelineHA(
            adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_unknown/state',
            '{ "status": "Normal"}',
        );
        assert.match(result.skipped ?? '', /unknown attribute/);
        assert.equal(Object.keys(adapter.states).length, 0);
    });

    it('Kein Haus konfiguriert → Fallback-Pfad', async () => {
        const adapter = createAdapterMock({});
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_online/state',
            '{ "status": "Online"}');
        // Fallback: devices.<bridgeId>.<deviceId>.online  (bridgeId = "15298924")
        assert.equal(adapter.states['devices.15298924.00000009.online'], true);
    });

    it('Mehrere State-Topics hintereinander – keine Überschneidung', async () => {
        const adapter = createAdapterMock(DEFAULT_HOUSES);
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_online/state',
            '{ "status": "Online"}');
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_battery/state',
            '{ "status": "Normal"}');
        await pipelineHA(adapter,
            'homeassistant/binary_sensor/SBS5015298924_00000009/SBS5015298924_00000009_lifeend/state',
            '{ "status": "Normal"}');

        assert.equal(adapter.states['devices.home.15298924.00000009.online'],    true,  'online');
        assert.equal(adapter.states['devices.home.15298924.00000009.batInfo'],   100,   'batInfo');
        assert.equal(adapter.states['devices.home.15298924.00000009.isLifeEnd'], false, 'isLifeEnd');
    });
});
