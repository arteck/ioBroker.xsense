/**
 *  JSON to ioBroker object converter for XSense devices
 */
class Json2iobXSense {
    /**
     *
     * @param adapter
     */
    constructor(adapter) {
        this.adapter = adapter;
    }

    /**
     *
     * @param basePath
     * @param obj
     */
    async parse(basePath, obj) {
        // home_id verarbeiten
        if (obj && typeof obj === 'object' && obj.hasOwnProperty('home_id')) {
            const homeIdValue = obj.home_id;
            delete obj.home_id;
            await this.setStateObject('devices.home_id', homeIdValue, false);
            this.createStaticDeviceObject();
        }

        let devicesContainer = obj.devices;
        if (devicesContainer && devicesContainer.devices) {
            devicesContainer = devicesContainer.devices;
        }

        if (!devicesContainer || typeof devicesContainer !== 'object') {
            return;
        }

        for (const key of Object.keys(devicesContainer)) {
            const device = devicesContainer[key];

            const serial = device?.serial;
            if (!serial) {
                continue;
            }

            const targetPath = `devices.${serial}`;
            const deviceName = typeof device.name === 'string' ? device.name : '';

            await this.createDeviceObject(basePath, await this.name2id(targetPath), await this.name2id(deviceName));
            await this.parseObject(targetPath, device);
        }
    }

    /**
     *
     * @param basePath
     * @param obj
     */
    async parseObject(basePath, obj) {
        for (const key in obj) {
            const value = obj[key];
            const fullPath = await this.name2id(`${basePath}.${key}`);

            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const arrayItem = value[index];
                    const itemName = arrayItem?.name || `index_${index}`;
                    const arrayPath = `${fullPath}.${itemName}`;

                    if (typeof arrayItem === 'object' && arrayItem !== null) {
                        await this.parseObject(arrayPath, arrayItem);
                    } else {
                        await this.setStateObject(arrayPath, arrayItem, false);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                await this.parseObject(fullPath, value);
            } else {
                await this.setStateObject(fullPath, value, false);
            }
        }
    }

    /**
     *
     * @param id
     * @param value
     */
    async setStateObject(id, value) {
        // Überprüfe, ob id auf online, muteStatus oder alarmStatus endet und value boolean ist
        const lastPart = id.split('.').pop();
        let type = typeof value;
        let role = 'value';

        const isNumericString = /^\d+$/.test(value);

        if (typeof value === 'string') {
            const lower = value.toLowerCase();

            if (!isNumericString && (lower === 'true' || lower === 'false')) {
                type = 'boolean';
                value = lower === 'true';
            } else if (isNumericString) {
                if (lastPart === 'serial') {
                    type = 'string';
                    role = 'info.id';
                } else {
                    type = 'number';
                    value = Number(value);
                    if (lastPart === 'time') {
                        role = 'value';
                    }
                }
            }
        }

        switch (true) {
            case lastPart === 'online':
                role = 'indicator.reachable';
                break;
            case lastPart === 'name':
                role = 'text';
                break;
            case lastPart.includes('alarm'):
                role = 'indicator.alarm';
                break;
            case /(co|rf|wifi)/i.test(lastPart): // regex macht's flexibler
                role = 'level';
                break;
        }

        const common = {
            name: lastPart,
            type: type,
            role: role,
            read: true,
            write: false,
        };

        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common,
            native: {},
        });

        await this.adapter.setStateAsync(id, { val: value, ack: true });
    }

    /**
     *
     * @param basePath
     * @param id
     * @param name
     */
    async createDeviceObject(basePath, id, name = '') {
        const serial = id.split('.').pop();

        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
                name: name || serial,
                statusStates: {
                    onlineId: `${basePath}.${id}.online`,
                },
            },
            native: {},
        });
    }

    /**
     *
     * @param pName
     */
    async name2id(pName) {
        return (pName || '').replace(this.adapter.FORBIDDEN_CHARS, '_');
    }

    /**
     *
     */
    async createStaticDeviceObject() {
        await this.adapter.setObjectNotExistsAsync('devices.forceRefresh', {
            type: 'state',
            common: {
                name: 'refresh manually',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
                def: false,
            },
            native: {},
        });
        this.adapter.subscribeStates('devices.forceRefresh');
    }
}

module.exports = Json2iobXSense;
