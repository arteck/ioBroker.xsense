class Json2iobXSense {
    constructor(adapter) {
        this.adapter = adapter;
    }

    async parse(basePath, obj, options = {}) {
        const write = options.write || false;

        // home_id verarbeiten
        if (obj && typeof obj === 'object' && obj.hasOwnProperty('home_id')) {
            const homeIdValue = obj.home_id;
            delete obj.home_id;
            await this.setStateObject('devices.home_id', homeIdValue, write);
        }

        let devicesContainer = obj.devices;
        if (devicesContainer && devicesContainer.devices) {
            devicesContainer = devicesContainer.devices;
        }

        if (!devicesContainer || typeof devicesContainer !== 'object') return;

        for (const key of Object.keys(devicesContainer)) {
            const device = devicesContainer[key];

            const serial = device?.serial;
            if (!serial) continue;

            const targetPath = `devices.${serial}`;
            const deviceName = typeof device.name === 'string' ? device.name : '';

            await this.createDeviceObject(targetPath, deviceName);
            await this.parseObject(targetPath, device, options);
        }
    }

    async parseObject(basePath, obj, options = {}) {
        //const write = options.write || false; // Objekte mit write-Option
        const write = false; // alle Objekte mit write-Option

        for (const key in obj) {
            const value = obj[key];
            const fullPath = `${basePath}.${key}`;

            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const arrayItem = value[index];
                    const itemName = arrayItem?.name || `index_${index}`;
                    const arrayPath = `${fullPath}.${itemName}`;

                    if (typeof arrayItem === 'object' && arrayItem !== null) {
                        await this.parseObject(arrayPath, arrayItem, options);
                    } else {
                        await this.setStateObject(arrayPath, arrayItem, write);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                await this.parseObject(fullPath, value, options);
            } else {
                await this.setStateObject(fullPath, value, write);
            }
        }
    }


    async setStateObject(id, value, write = false) {
        // Überprüfe, ob id auf online, muteStatus oder alarmStatus endet und value boolean ist
        const lastPart = id.split('.').pop();
        let type = typeof value;
        let role = 'state';

        const isNumericString = /^\d+$/.test(value);

        if (typeof value === 'string' && !isNumericString) {
            const lower = value.toLowerCase();
            if (lower === 'true' || lower === 'false') {
                type = 'boolean';
                value = lower === 'true';  // true oder false als Boolean
            }
        }

        if (isNumericString) {
            if (lastPart === 'serial') {
                type = 'string'; // Serialnummer bleibt String
                role = 'info.id';
            } else {
                type = 'number';
                value = Number(value); // Konvertiere String zu Number
                if (lastPart === 'time') { // Spezielle Behandlung für Zeitangaben
                    role = 'value.time'
                }
            }
        }

        const common = {
            name: lastPart,
            type: type,
            role: role,
            read: true,
            write: write,
        };

        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common,
            native: {},
        });

        await this.adapter.setStateAsync(id, { val: value, ack: true });
    }

    async createDeviceObject(id, name = '') {
        const serial = id.split('.').pop();

        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
                name: name || serial,
                statusStates: {
                    onlineId: `xsense.0.devices.${serial}.online`
                }
            },
            native: {},
        });
    }
}


module.exports = Json2iobXSense;
