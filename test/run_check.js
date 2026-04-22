'use strict';
const fs = require('fs');
const J2I = require('../lib/json2iob.js');

const states = {}, objects = {}, subs = [];
const adapter = {
    FORBIDDEN_CHARS: /[*?[\]]/g,
    objects, states,
    async setObjectNotExistsAsync(id, o) { if (!objects[id]) objects[id] = o; },
    async setStateAsync(id, s) { states[id] = s; },
    async getStateAsync(id) { return states[id] || null; },
    subscribeStates(id) { subs.push(id); },
};

const j2i = new J2I(adapter);
const houses = {
    UUID: {
        houseId: '9FC3BB7E6A2311F0',
        name: 'Mein Haus',
        region: 'eu-west-1', mqttRegion: 'eu-west-1', mqttServer: 'mqtt.x-sense-iot.com',
        stations: {
            SBS001: {
                stationId: 'ST001', serial: 'SBS001', name: 'Bridge 1', type: 'SBS50', online: true, data: {},
                devices: {
                    DEV001: { deviceId: 'DV001', serial: 'DEV001', name: 'Sensor 1', type: 'XS01', online: true, data: { batInfo: 2, isLifeEnd: false } },
                },
            },
        },
    },
};

j2i.parseHouses('xsense.0', houses).then(() => {
    const folderKey = Object.keys(objects).find(k => k !== 'devices' && objects[k].type === 'folder' && k.startsWith('devices.'));
    const homeId    = states[`${folderKey}.home_id`]?.val;
    const batInfo   = states[`${folderKey}.SBS001.DEV001.batInfo`]?.val;
    const isLifeEnd = states[`${folderKey}.SBS001.DEV001.isLifeEnd`]?.val;

    const results = [
        `Haus-Ordner: ${folderKey}   → erwartet: devices.Mein_Haus`,
        `home_id:     ${homeId}      → erwartet: 9FC3BB7E6A2311F0`,
        `batInfo:     ${batInfo}%    → erwartet: 67%`,
        `isLifeEnd:   ${isLifeEnd}   → erwartet: false`,
    ];
    results.forEach(r => process.stdout.write(r + '\n'));
    fs.writeFileSync('C:/temp/check_result.txt', results.join('\n'));
}).catch(e => { process.stdout.write('ERROR: ' + e.message + '\n'); });
