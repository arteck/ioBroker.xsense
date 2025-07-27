const utils = require('@iobroker/adapter-core');
const connectMqtt = require('./lib/mqtt');
const config = require('./lib/config');

const default_region = 'eu-west-1'; // Default region if not specified in config

const { PythonShell } = require('python-shell');
const path = require('path');

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
            this.log.info('Starte Login bei X-Sense...');
            const credentials = await this.xsenseLogin(this); // liefert AWS-Credentials zurück

            // MQTT verbinden
            this.mqttClient = connectMqtt(this, credentials, {
                region: this.config.userRegion,
                iotEndpoint: this.config.iotEndpoint, // z. B. aus adapter.config oder fest
            });

            // Geräte abrufen (evtl. eigene Methode → musst du anpassen!)
            const devices = await this.fetchDeviceList(credentials.aws_access_key_id); // oder wenn du accessToken bekommst: credentials.accessToken

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

            this.log.info(`Es wurden ${devices.length} Geräte geladen.`);
        } catch (err) {
            this.log.error(`Fehler beim Login oder Setup: ${err.message}`);
        }
    }


    async xsenseLogin(adapter) {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, '..', 'iobroker-data', 'xsense', 'run_xsense.py');



            let asda =  this.adapter.getDataFolder();

            const email = this.config.mqttUser;
            const password = this.config.mqttPassword;
            const region = 'eu';

            if (!email || !password) {
                return reject(new Error('Benutzername oder Passwort fehlt in den Adapter-Einstellungen.'));
            }

            const options = {
                args: [email, password, region],
                pythonOptions: ['-u'], // unbuffered output
            };

            PythonShell.run(scriptPath, options, function (err, results) {
                if (err) {
                    adapter.log.error('Python-Fehler: ' + err.toString());
                    return reject(err);
                }

                try {
                    const output = results.join('');
                    const json = JSON.parse(output);

                    if (json.error) {
                        adapter.log.warn('Fehler von Python: ' + json.error);
                        return reject(new Error(json.error));
                    }

                    adapter.log.info('X-Sense Login erfolgreich. AWS-Credentials erhalten.');
                    resolve(json); // enthält z. B. accessKeyId, secretAccessKey, sessionToken
                } catch (e) {
                    adapter.log.error('Fehler beim Parsen der Python-Antwort: ' + e.toString());
                    reject(e);
                }
            });
        });
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
