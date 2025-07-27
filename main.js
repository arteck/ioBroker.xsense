const utils = require('@iobroker/adapter-core');
const authenticate = require('./lib/auth');
const connectMqtt = require('./lib/mqtt');
const config = require('./lib/config');

const default_region = 'eu-west-1'; // Default region if not specified in config



global.fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));


/**
 * -------------------------------------------------------------------
 * ioBroker X-Sense Adapter
 * -------------------------------------------------------------------
 */
class xsenseControll  extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'xsense'
        });




        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }



    async onReady() {
        try {
            this.setState('info.connection', {val: false, ack: true});

            this.config.userRegion = default_region;

            const credentials = await authenticate(this.config.mqttUser, this.config.mqttPassword, this.config.userRegion);

            this.mqttClient = connectMqtt(this, credentials, {
                region: this.config.userRegion,
                iotEndpoint: config.iot.endpoint
            });

            const devices = await this.fetchDeviceList(credentials.accessToken);

            for (const dev of devices) {
                const devicePath = `devices.${dev.uuid}`;
                await this.setObjectNotExistsAsync(devicePath, {
                    type: 'device',
                    common: {
                        name: dev.deviceName || dev.uuid,
                    },
                    native: dev,
                });
            }

















        } catch (err) {
            this.log.error('Auth/MQTT error: ' + err.message);
            return;
        }
    }

    async onStateChange(stateId, stateObj) {

    }

    async onUnload(callback) {
        try {
            if (this.mqttClient) this.mqttClient.end();
            callback();
        } catch (e) {
            callback();
        }
    }


    async fetchDeviceList(accessToken) {
        const res = await fetch('https://api.gosense.io/api/device/list', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
        if (!res.ok) throw new Error('Fehler beim Abrufen der Geräte');
        const json = await res.json();
        return json.data;
    }
    async createDeviceObjects(device) {
        try {
            await this.setObjectNotExistsAsync(device.id, {
                type: 'device',
                common: {
                    name: device.name,
                    statusStates: {
                        onlineId: `${this.namespace}.${device.id}.alive`
                    }
                },
                native: {}
            });
            await this.setObjectNotExistsAsync(device.id + '.Info', {
                type: 'channel',
                common: {
                    name: 'Device Information'
                },
                native: {}
            });
            await this.setObjectNotExistsAsync(device.id + '.alive', {
                type: 'state',
                common: {
                    name: 'Is Fully alive?',
                    desc: 'If Fully Browser is alive or not',
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false
                },
                native: {}
            });
            await this.setObjectNotExistsAsync(device.id + '.lastInfoUpdate', {
                type: 'state',
                common: {
                    name: 'Last information update',
                    desc: 'Date/time of last information update from Fully Browser',
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false
                },
                native: {}
            });

            return true;
        } catch (e) {
            this.log.error(this.err2Str(e));
            return false;
        }
    }

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
    module.exports = (options) => new xsenseControll(options);
} else {
    // otherwise start the instance directly
    new xsenseControll();
}
