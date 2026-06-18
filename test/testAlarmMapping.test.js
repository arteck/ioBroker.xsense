'use strict';

const assert = require('node:assert/strict');
const { XSenseClient } = require('../lib/xsenseClient');

function mockLog() {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe('XSenseClient - testAlarm action mapping', () => {
    it('uses the APK self-test path for generic XS01 on SBS50', async () => {
        const client = new XSenseClient(mockLog());
        client.userId = 'user123';
        client.houses = {
            HOUSE1: {
                houseId: 'HOUSE1',
                stations: {
                    ST1: {
                        serial: '1599CFB4',
                        type: 'SBS50',
                        mqttRegion: 'eu-west-1',
                        devices: {
                            DEV1: { serial: '00000001', type: 'XS01' },
                        },
                    },
                },
            },
        };

        let capturedTopic = null;
        let capturedBody = null;
        client.doThingShadow = async (_station, topic, body) => {
            capturedTopic = topic;
            capturedBody = body;
            return { ok: true };
        };

        const result = await client.testAlarm('00000001');
        assert.equal(capturedTopic, '2nd_selftest_00000001');
        assert.equal(capturedBody.state.desired.shadow, 'appSelfTest');
        assert.equal(capturedBody.state.desired.userParam, 'source=1');
        assert.match(capturedBody.state.desired.time, /^\d{13}$/);
        assert.equal(result, 'Testalarm-Request gesendet für 00000001');
    });

    it('uses app2ndSelfTest for XS01-M with smokeEdition 9', async () => {
        const client = new XSenseClient(mockLog());
        client.userId = 'user123';
        client.houses = {
            HOUSE1: {
                houseId: 'HOUSE1',
                stations: {
                    ST1: {
                        serial: '1599CFB4',
                        type: 'SBS50',
                        mqttRegion: 'eu-west-1',
                        devices: {
                            DEV1: { serial: '00000001', type: 'XS01-M', data: { smokeEdition: '9' } },
                        },
                    },
                },
            },
        };

        let capturedBody = null;
        client.doThingShadow = async (_station, _topic, body) => {
            capturedBody = body;
            return { ok: true };
        };

        await client.testAlarm('00000001');
        assert.equal(capturedBody.state.desired.shadow, 'app2ndSelfTest');
        assert.equal(capturedBody.state.desired.userParam, 'source=1');
        assert.match(capturedBody.state.desired.time, /^\d{13}$/);
    });

    it('uses the legacy standalone self-test path for XS01-M on SBS10 with smokeEdition 8', async () => {
        const client = new XSenseClient(mockLog());
        client.userId = 'user123';
        client.houses = {
            HOUSE1: {
                houseId: 'HOUSE1',
                stations: {
                    ST1: {
                        serial: '1599CFB4',
                        type: 'SBS10',
                        mqttRegion: 'eu-west-1',
                        devices: {
                            DEV1: { serial: '00000001', type: 'XS01-M', data: { smokeEdition: '8' } },
                        },
                    },
                },
            },
        };

        let capturedTopic = null;
        let capturedBody = null;
        client.doThingShadow = async (_station, topic, body) => {
            capturedTopic = topic;
            capturedBody = body;
            return { ok: true };
        };

        await client.testAlarm('00000001');
        assert.equal(capturedTopic, 'appselftest_00000001');
        assert.equal(capturedBody.state.desired.shadow, 'appSelfTest');
        assert.equal('userParam' in capturedBody.state.desired, false);
        assert.equal('time' in capturedBody.state.desired, false);
    });
});
