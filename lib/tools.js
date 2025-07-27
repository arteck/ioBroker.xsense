const utils = require('@iobroker/adapter-core');
const path = require('path');

function getDataFolder(adapter) {
    const datapath = adapter.namespace.replace('.', '_');
    return path.join(utils.getAbsoluteInstanceDataDir(adapter).replace(adapter.namespace, datapath));
}

function parseXSenseOutput(rawOutput) {
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

        const deviceHeaderMatch = line.match(/^(.+?) \((SBS50|XS01-M)\):$/);
        if (deviceHeaderMatch) {
            if (currentDevice) {
                // Vor dem Pushen online-Status final setzen
                finalizeOnlineStatus(currentDevice);
                result.devices.push(currentDevice);
            }

            const rawName = deviceHeaderMatch[1].replace(/�/g, 'ä');
            const model = deviceHeaderMatch[2];

            currentDevice = {
                name: `${rawName}_${model}`,
                serial: null,
                onlineMain: null,   // online aus Hauptblock (yes/no)
                onlineValues: null, // online aus values (1/0)
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
                // nur im Hauptblock, speichern aber noch nicht final
                currentDevice.onlineMain = val.toLowerCase();
            } else if (key === 'values') {
                const rawValues = val.trim().replace(/^{|}$/g, '');
                const pairs = rawValues.split(/,(?![^{]*})/);

                pairs.forEach(pair => {
                    let [k, ...vParts] = pair.split(':');
                    if (k && vParts.length > 0) {
                        k = k.trim().replace(/^'|'$/g, '');
                        let v = vParts.join(':').trim();
                        v = v.replace(/^'|'$/g, '');
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

    return result;
}

function finalizeOnlineStatus(device) {
    // Wenn onlineValues gesetzt (z.B. "1" oder "0"), nutze das
    if (device.onlineValues !== null) {
        device.online = device.onlineValues;
    } else if (device.onlineMain !== null) {
        // sonst konvertiere onlineMain: yes->1, no->0
        if (device.onlineMain === 'yes') {
            device.online = '1';
        } else if (device.onlineMain === 'no') {
            device.online = '0';
        } else {
            device.online = device.onlineMain; // fallback, unverändert
        }
    } else {
        device.online = null;
    }
    delete device.onlineMain;
    delete device.onlineValues;
}



module.exports = {
    getDataFolder,
    parseXSenseOutput
};
