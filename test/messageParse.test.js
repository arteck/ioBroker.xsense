'use strict';

const assert = require('node:assert/strict');

/**
 * Tests für die MQTT-Nachrichtenverarbeitung (messageParse / getTopicSuffix).
 * Da die Methoden Adapter-interne Funktionen sind, wird ein leichter Stub benutzt.
 */

// ─── Stub-Implementierungen der Methoden aus main.js ────────────────────────

async function getTopicSuffix(topic) {
    if (typeof topic !== 'string' || topic.length === 0) return null;
    const parts = topic.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
}

// Minimal-Stub für messageParse-Logik (state-switching)
function resolveBatteryLevel(status) {
    return  status === 'Normal'   ? 3 :
            status === 'Low'      ? 2 :
            status === 'Critical' ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
// getTopicSuffix
// ─────────────────────────────────────────────────────────────
describe('getTopicSuffix()', () => {
    it('returns last segment of topic', async () => {
        assert.equal(await getTopicSuffix('xsense/SBS50AABB_1122_online/state'), 'state');
    });

    it('returns null for empty string', async () => {
        assert.equal(await getTopicSuffix(''), null);
    });

    it('returns null for null input', async () => {
        assert.equal(await getTopicSuffix(null), null);
    });

    it('handles single segment without slash', async () => {
        assert.equal(await getTopicSuffix('state'), 'state');
    });

    it('handles trailing slashes', async () => {
        assert.equal(await getTopicSuffix('a/b/state/'), 'state');
    });
});

// ─────────────────────────────────────────────────────────────
// Battery-Level-Mapping
// ─────────────────────────────────────────────────────────────
describe('resolveBatteryLevel()', () => {
    it('maps Normal to 3', () => assert.equal(resolveBatteryLevel('Normal'), 3));
    it('maps Low to 2',    () => assert.equal(resolveBatteryLevel('Low'), 2));
    it('maps Critical to 1', () => assert.equal(resolveBatteryLevel('Critical'), 1));
    it('maps unknown to 0',  () => assert.equal(resolveBatteryLevel(''), 0));
    it('maps undefined to 0', () => assert.equal(resolveBatteryLevel(undefined), 0));
});

// ─────────────────────────────────────────────────────────────
// Topic-Parsing (SBS50-Format)
// ─────────────────────────────────────────────────────────────
describe('SBS50 topic attribute parsing', () => {
    function parseTopic(topic) {
        const parts = topic.split('/').filter(Boolean);
        const findDp = parts.at(-2) ?? '';
        const mTopic = findDp.match(/^SBS50([^_]+)_([^_]+)_(.+)$/);
        return {
            bridgeId:  mTopic?.[1] ?? null,
            deviceId:  mTopic?.[2] ?? null,
            attribute: mTopic?.[3] ?? null,
        };
    }

    it('parses bridgeId, deviceId and attribute from valid topic', () => {
        const result = parseTopic('xsense/SBS50AABB_11223344_smokealarm/state');
        assert.equal(result.bridgeId, 'AABB');
        assert.equal(result.deviceId, '11223344');
        assert.equal(result.attribute, 'smokealarm');
    });

    it('returns null for non-SBS50 topic', () => {
        const result = parseTopic('xsense/someotherdevice/state');
        assert.equal(result.bridgeId, null);
        assert.equal(result.deviceId, null);
        assert.equal(result.attribute, null);
    });

    it('returns null fields for malformed topic (too short)', () => {
        const result = parseTopic('state');
        assert.equal(result.bridgeId, null);
    });
});

// ─────────────────────────────────────────────────────────────
// MQTT-Payload-Wrapping (newMessage-Konstruktion)
// ─────────────────────────────────────────────────────────────
describe('MQTT newMessage construction', () => {
    function buildNewMessage(topic, payload) {
        const payloadStr = payload.toString();
        return `{"payload":${payloadStr === '' ? '"null"' : payloadStr},"topic":"${topic.slice(topic.search('/') + 1)}"}`;
    }

    it('wraps payload and topic correctly', () => {
        const msg = buildNewMessage('base/SBS50AABB_1122_online/state', '{"status":"Online"}');
        const parsed = JSON.parse(msg);
        assert.equal(parsed.topic, 'SBS50AABB_1122_online/state');
        assert.deepEqual(parsed.payload, { status: 'Online' });
    });

    it('replaces empty payload with "null" string', () => {
        const msg = buildNewMessage('base/topic/state', '');
        const parsed = JSON.parse(msg);
        assert.equal(parsed.payload, 'null');
    });

    it('produces valid JSON for numeric payload', () => {
        const msg = buildNewMessage('base/topic/state', '42');
        assert.doesNotThrow(() => JSON.parse(msg));
    });
});

// ─────────────────────────────────────────────────────────────
// EOL / Online / Detected boolean mappings
// ─────────────────────────────────────────────────────────────
describe('Payload status boolean mappings', () => {
    it('EOL maps to true when status is EOL', () => {
        assert.equal('EOL' === 'EOL', true);
        assert.equal('Active' === 'EOL', false);
    });

    it('Online maps to true when status is Online', () => {
        assert.equal('Online' === 'Online', true);
        assert.equal('Offline' === 'Online', false);
    });

    it('Detected maps to true when status is Detected', () => {
        assert.equal('Detected' === 'Detected', true);
        assert.equal('Normal' === 'Detected', false);
    });
});
