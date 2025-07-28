const utils = require('@iobroker/adapter-core');
const path = require('path');

function getDataFolder(adapter) {
    const datapath = adapter.adapterDir + '/python/';
    return datapath;
}

function parseXSenseOutput(rawOutput, knownSerials = []) {
    const lines = rawOutput.split(/\r?\n/);
    const result = { home_id: null, devices: [] };

    let currentDevice = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const homeMatch = line.match(/\[ home \(([A-F0-9]+)\) \]/i);
        if (homeMatch) {
            result.home_id = homeMatch[1];
            continue;
        }

        const deviceHeaderMatch = line.match(/^(.+?) \(([^)]+)\):$/);
        if (deviceHeaderMatch) {
            if (currentDevice) {
                finalizeOnlineStatus(currentDevice);
                result.devices.push(currentDevice);
            }

            const rawName = deviceHeaderMatch[1].replace(/�/g, 'ä');
            const model = deviceHeaderMatch[2];

            currentDevice = {
                name: `${rawName}`,
                serial: null,
                onlineMain: null,
                onlineValues: null,
            };

            continue;
        }

        const kvMatch = line.match(/^(\w+)\s+:\s+(.*)$/);
        if (kvMatch && currentDevice) {
            let [, key, val] = kvMatch;
            val = val.trim();

            if (key === 'serial') {
                currentDevice.serial = val;
            } else if (key === 'online') {
                currentDevice.onlineMain = val.toLowerCase();
            } else if (key === 'values') {
                const rawValues = val.trim().replace(/^{|}$/g, '');
                const pairs = rawValues.split(/,(?![^{]*})/);

                pairs.forEach(pair => {
                    let [k, ...vParts] = pair.split(':');
                    if (k && vParts.length > 0) {
                        k = k.trim().replace(/^'|'$/g, '');
                        let v = vParts.join(':').trim().replace(/^'|'$/g, '');
                        if (k === 'online') {
                            currentDevice.onlineValues = v;
                        } else {
                            currentDevice[k] = v;
                        }
                    }
                });
            }
        }

        const nextLine = lines[i + 1] || '';
        if (nextLine.match(/^(.+?) \((SBS50|XS01-M)\):$/) && currentDevice) {
            finalizeOnlineStatus(currentDevice);
            result.devices.push(currentDevice);
            currentDevice = null;
        }
    }

    if (currentDevice) {
        finalizeOnlineStatus(currentDevice);
        result.devices.push(currentDevice);
    }

    // === Geräte ergänzen, die fehlen ===
    const foundSerials = result.devices.map(dev => dev.serial).filter(Boolean);
    for (const knownSerial of knownSerials) {
        if (!foundSerials.includes(knownSerial)) {
            result.devices.push({
                name: null,     // Name ist unbekannt
                serial: knownSerial,
                online: '0'
            });
        }
    }

    return result;
}

function finalizeOnlineStatus(device) {
    if (device.onlineValues !== null) {
        device.online = device.onlineValues;
    } else if (device.onlineMain !== null) {
        if (device.onlineMain === 'yes') {
            device.online = '1';
        } else if (device.onlineMain === 'no') {
            device.online = '0';
        } else {
            device.online = device.onlineMain;
        }
    } else {
        device.online = null;
    }
    delete device.onlineMain;
    delete device.onlineValues;
}

function extractDeviceIds(devices) {
    return devices.map(device => {
        const parts = device._id.split('.');
        return parts[parts.length - 1]; // letzter Teil = Seriennummer
    });
}
module.exports = {
    getDataFolder,
    parseXSenseOutput,
    extractDeviceIds
};
