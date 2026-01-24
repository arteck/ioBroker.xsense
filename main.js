const utils = require('@iobroker/adapter-core');
const tools = require('./lib/tools');
const Json2iobXSense = require('./lib/json2iob');
const path = require('path');
const MqttServerController = require('./lib/mqttServerController').MqttServerController;
const mqtt = require('mqtt');

global.fetch = require('node-fetch-commonjs');

let _outputBuffer = Buffer.alloc(0);

let index = 0;
let mqttServerController;
let mqttClient;
let messageParseMutex = Promise.resolve();

/**
 * -------------------------------------------------------------------
 * ioBroker X-Sense Adapter
 * -------------------------------------------------------------------
 */
class xsenseControll extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'xsense',
        });

        this.json2iob = new Json2iobXSense(this);
        this.pythonConnected = false;

        this._requestInterval = 0;
        this._loginInProgress = false;
        this._bridgeInterval = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        try {
            let loginGo = true;
            this.log.info('Start X-Sense... waiting ....');

            await this.json2iob.createStaticDeviceObject();
            if (this.config.userEmail == '') {
                this.log.error('Check Settings. No Username set');
                loginGo = false;
            }
            if (this.config.userPassword == '') {
                this.log.error('Check Settings. No Password set');
                loginGo = false;
            }

            // MQTT
            if (this.config.useMqttServer && loginGo) {
                if (['exmqtt', 'intmqtt'].includes(this.config.connectionType)) {
                    // External MQTT-Server
                    const clientId = `ioBroker.xsense_${Math.random().toString(16).slice(2, 8)}`;
                    if (this.config.connectionType == 'exmqtt') {
                        if (this.config.externalMqttServerIP == '') {
                            this.log.warn('Please configure the External MQTT-Server connection!');
                            return;
                        }

                        // MQTT connection settings
                        const mqttClientOptions = {
                            clientId: clientId,
                            clean: true,
                            reconnectPeriod: 500,
                        };

                        // Set external mqtt credentials
                        if (this.config.externalMqttServerCredentials == true) {
                            mqttClientOptions.username = this.config.externalMqttServerUsername;
                            mqttClientOptions.password = this.config.externalMqttServerPassword;
                        }

                        // Init connection
                        mqttClient = mqtt.connect(
                            `mqtt://${this.config.externalMqttServerIP}:${this.config.externalMqttServerPort}`,
                            mqttClientOptions,
                        );
                    } else {
                        // Internal MQTT-Server

                        mqttServerController = new MqttServerController(this);
                        await mqttServerController.createMQTTServer();
                        await this.delay(1500);
                        mqttClient = mqtt.connect(
                            `mqtt://${this.config.mqttServerIPBind}:${this.config.mqttServerPort}`,
                            {
                                clientId: clientId,
                                clean: true,
                                reconnectPeriod: 500,
                            },
                        );
                    }

                    // MQTT Client
                    mqttClient.on('connect', () => {
                        this.log.info(
                            `Connect to Xsense_MQTT over ${this.config.connectionType == 'exmqtt' ? 'external mqtt' : 'internal mqtt'} connection.`,
                        );
                    });

                    mqttClient.subscribe(`${this.config.baseTopic}`);

                    mqttClient.on('message', (topic, payload) => {
                        const newMessage = `{"payload":${payload.toString() == '' ? '"null"' : payload.toString()},"topic":"${topic.slice(topic.search('/') + 1)}"}`;
                        this.messageParse(newMessage);
                    });
                }
            }

            if (loginGo) {
                this.callPython = (await this.getState('info.callPython'))?.val;
                if (this.config.isWindowsSystem) {
                    this.callPython = 'python';
                }

                this.setAllAvailableToFalse();
                this.python = await this.setupXSenseEnvironment(true);

                this.log.debug(`python ${JSON.stringify(this.python)}`);

                if (this.python) {
                    const resp = await this.callLogin(this.config.userEmail, this.config.userPassword);

                    this.log.debug(`response ${JSON.stringify(resp)}`);

                    if (resp) {
                        this.setState('info.connection', true, true);
                        this.startIntervall();
                    }
                }
            } else {
                this.log.debug(`login to cloud skipped`);
            }
        } catch (err) {
            this.setState('info.connection', false, true);
            this.log.error(`Error : ${err.message}`);
            return;
        }
    }

    async messageParse(message) {
        // Mutex lock: queue up calls to messageParse
        let release;
        const lock = new Promise(resolve => (release = resolve));
        const prev = messageParseMutex;
        messageParseMutex = lock;
        await prev;
        try {
            if (tools.isJson(message) == false && !this.pythonConnected) {
                // Nur verarbeiten, wenn gültiges JSON und Python verbunden ist ..da sonst keine strukturen vorhaden
                return;
            }

            const messageObj = JSON.parse(message);

            this.log.debug(`Message ${JSON.stringify(messageObj)}`);

            if (!messageObj.topic.includes('SBS50')) {
                this.log.error(
                    `Bridge SBS50 not found in topic: ${messageObj.topic}. Aborting message processing. Check your whether you have a correct Bridge`,
                );
                return;
            }

            const suffix = await this.getTopicSuffix(messageObj.topic);

            switch (suffix) {
                case 'state': {
                    const mTopic = messageObj.topic.match(/SBS50(\d+)_([0-9]+)\/[^/]*_([A-Za-z0-9]+)\/state$/);

                    const bridgeId = mTopic?.[1] ?? null; // z.B. "15298924"
                    const deviceId = mTopic?.[2] ?? null; // z.B. "00000003"
                    const attribute = mTopic?.[3] ?? null; // z.B. "online"

                    switch (attribute) {
                        case 'battery': {
                            // hier müssen wir noch anpassen
                            const batLevel =
                                messageObj.payload.status === 'Normal'
                                    ? '3'
                                    : messageObj.payload.status === 'Low'
                                      ? '2'
                                      : messageObj.payload.status === 'Critical'
                                        ? '1'
                                        : '0';
                            this.setStateAsync(`devices.${bridgeId}.${deviceId}.batInfo`, { val: batLevel, ack: true });
                            break;
                        }
                        case 'lifeend':
                            this.setStateAsync(`devices.${bridgeId}.${deviceId}.isLifeEnd`, {
                                val: messageObj.payload.status == 'EOL',
                                ack: true,
                            });
                            break;
                        case 'online':
                            this.setStateAsync(`devices.${bridgeId}.${deviceId}.online`, {
                                val: messageObj.payload.status == 'Online',
                                ack: true,
                            });
                            break;

                        case 'smokealarm':
                        case 'heatalarm':
                        case 'coalarm':
                            this.setStateAsync(`devices.${bridgeId}.${deviceId}.alarmStatus`, {
                                val: messageObj.payload.status == 'Detected',
                                ack: true,
                            });
                            break;

                        case 'smokefault':
                        case 'heatfault':
                        case 'cofault':
                            break;

                        default:
                            this.log.warn(`Unknown attribute in topic: ${messageObj.topic}`);
                            break;
                    }

                    break;
                }
                default: {
                    this.log.debug(`Unknown topic: ${messageObj.topic}`);
                    break;
                }
            }
        } finally {
            release();
        }
    }

    async getTopicSuffix(topic) {
        if (typeof topic !== 'string' || topic.length === 0) {
            return null;
        }
        const parts = topic.split('/').filter(Boolean); // entfernt leere Teile
        return parts.length ? parts[parts.length - 1] : null;
    }

    async startIntervall() {
        this.log.debug('[XSense] Start intervall');

        if (!this.python) {
            this.log.warn('Python environment not initialized. Trying again...');
            this.python = await this.setupXSenseEnvironment();

            if (!this.python) {
                this.setState('info.connection', false, true);
                return;
            }
        }

        await this.datenVerarbeiten(false);

        if (!this._requestInterval) {
            this.log.debug(` Start XSense request intervall`);
            this._requestInterval = setInterval(async () => {
                await this.startIntervall();
            }, this.config.polltime * 1000);
        }
    }

    async datenVerarbeiten(firstTry) {
        this.log.debug('[XSense] datenVerarbeiten called');
        this.log.debug('[XSense] This may take up to 1 minute. Please wait');

        try {
            const response = await this.callBridge();

            if (response.length > 30) {
                // hole alle devices und vergleiche ob was offline ist
                const devices = await this.getDevicesAsync();
                const knownDevices = tools.extractDeviceIds(devices);

                const parsed = tools.parseXSenseOutput(response, knownDevices);

                this.log.debug(`[XSense] parsed ${JSON.stringify(parsed)}`);

                await this.json2iob.parse(this.namespace, parsed);

                this.pythonConnected = true;
            } else {
                this.log.error(`[XSense] No data received from bridge: ${response}`);
                this.setState('info.connection', false, true);

                if (response.includes('is logged in')) {
                    const resp = await this.callLogin(this.config.userEmail, this.config.userPassword);

                    if (resp) {
                        this.setState('info.connection', true, true);
                        this.startIntervall();
                    }
                }
            }
        } catch (err) {
            this.errorMessage(err, firstTry);
        }
    }

    async setupXSenseEnvironment(firstTry) {
        try {
            const { getVenv } = await import('autopy');
            const pfadPythonScript = tools.getDataFolder(this);
            this.log.debug('[XSense] getVenv imported from autopy');

            const python = await getVenv({
                name: 'xsense-env',
                pythonVersion: this.config.pythonVersion,
                requirements: [
                    { name: 'requests', version: '' },
                    { name: 'aiohttp', version: '' },
                ],
                extraPackages: [`${pfadPythonScript}python-xsense`],
            });

            this.log.debug('[XSense] Python environment ready ');

            return python;
        } catch (err) {
            this.errorMessage(err, firstTry);
        }
    }

    async callLogin(email, password) {
        this.log.debug('[XSense] callLogin ');

        if (this._loginInProgress) {
            this.log.warn('[XSense] callLogin already running – skipping');
            return;
        }
        this._loginInProgress = true;

        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'python', 'login.py');
            const proc = this.python(this.callPython, [scriptPath, email, password]);

            let finished = false; // Guard-Flag
            let output = Buffer.alloc(0);

            const timeout = this.setTimeout(() => {
                if (finished) {
                    return;
                }
                finished = true;

                this.log.error(`[XSense] callLogin timeout nach ${this.config.pythonTimeout}ms – Prozess wird beendet`);
                proc.kill('SIGKILL');
                reject(new Error(`[XSense] callLogin Timeout nach ${this.config.pythonTimeout}ms`));
            }, 1000 * this.config.pythonTimeout);

            proc.stdout?.on('data', chunk => {
                output = Buffer.concat([output, chunk]);
                this.log.debug(`[XSense] callLogin received ${chunk.length} bytes`);
                this.log.debug(`[XSense] callLogin : ${chunk.toString()}`);
            });

            proc.stdout?.on('end', () => {
                if (finished) {
                    return;
                }
                finished = true;

                this.clearTimeout(timeout);
                _outputBuffer = output; // Pickle zwischenspeichern
                this._loginInProgress = false;
                this.log.debug(`[XSense] Pickle Bytes length: ${output.length}`);
                resolve(true);
            });

            proc.stderr?.on('data', data => {
                if (finished) {
                    return;
                }
                finished = true;

                this.clearTimeout(timeout);
                this._loginInProgress = false;
                this.log.warn(`[XSense] callLogin request error: ${data.toString()}`);
                reject(new Error(`[XSense] Python error: ${data.toString()}`));
            });
        });
    }
    async callBridge() {
        this.log.debug('[XSense] callBridge ');

        if (!_outputBuffer) {
            throw new Error('No Pickle buffer available – callLogin first!');
        }

        let result = '';

        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'python', 'getData.py');
            const proc = this.python(this.callPython, [scriptPath]);

            let output = Buffer.alloc(0);
            let finished = false; // schützt vor doppeltem resolve/reject

            proc.stdin.write(_outputBuffer);
            proc.stdin.end();

            proc.stdout.on('data', chunk => {
                output = Buffer.concat([output, chunk]);
                result = chunk.toString();
                this.log.debug(`[XSense] chunck callBridge ${chunk.toString()}`);
            });

            proc.stdout.on('end', () => {
                if (finished) {
                    return;
                }
                finished = true;

                this.log.debug(`[XSense] total Pickle Bytes received: ${output.length}`);
                index = 0;
                resolve(result);
            });

            proc.stderr.on('data', err => {
                if (finished) {
                    return;
                }
                index = 0;
                finished = true;
                reject(new Error(`process_pickle error: ${err.toString()}`));
            });
        });
    }

    async onStateChange(stateId, stateObj) {
        if (!stateObj) {
            return;
        }

        if (stateObj.ack) {
            return;
        }

        this.log.debug(`New Event for state: ${JSON.stringify(stateObj)}`);
        this.log.debug(`ID: ${JSON.stringify(stateId)}`);

        let tmpControl = stateId.split('.')[3];

        try {
            switch (tmpControl) {
                case 'forceRefresh':
                    await this.datenVerarbeiten(false);
                    break;
                default:
                    tmpControl = stateId.split('.')[5];
                    if (tmpControl === 'test_Alarm') {
                        await this.testAlarm(stateId);
                    }
            }
        } catch (err) {
            this.log.error(`Error onStateChange ${err}`);
        }
    }

    async testAlarm(idDeviceState) {
        this.log.debug(`Test Alarm for device: ${idDeviceState}`);

        const id = idDeviceState.split('.')[4];
        await this.setStateAsync(`${idDeviceState}_Message`, { val: 'in progress', ack: true });

        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'python', 'checkAlarm.py');
            const proc = this.python(this.callPython, [scriptPath, id]);

            let output = Buffer.alloc(0);
            let finished = false; // schützt vor doppeltem resolve/reject

            proc.stdin.write(_outputBuffer);
            proc.stdin.end();

            proc.stdout.on('data', chunk => {
                output = Buffer.concat([output, chunk]);
                this.log.debug(`[XSense] chunck testAlarm ${chunk.toString()}`);
                if (chunk.toString().trim().length > 1) {
                    this.setStateAsync(`${idDeviceState}_Message`, { val: chunk.toString(), ack: true });
                }
            });

            proc.stdout.on('end', () => {
                if (finished) {
                    return;
                }
                finished = true;

                this.log.debug(`[XSense] total Pickle Bytes received: ${output.length}`);
                index = 0;
                resolve(true);
            });

            proc.stderr.on('data', err => {
                if (finished) {
                    return;
                }
                index = 0;
                finished = true;
                reject(new Error(`process_pickle error: ${err.toString()}`));
            });
        });
    }

    async onUnload(callback) {
        try {
            if (this._requestInterval) {
                this.clearInterval(this._requestInterval);
            }
            this.setAllAvailableToFalse();
            callback();
        } catch (e) {
            callback();
        }
    }

    async setAllAvailableToFalse() {
        const availableStates = await this.getStatesAsync('*.online');
        for (const availableState in availableStates) {
            await this.setStateChangedAsync(availableState, false, true);
        }
    }

    async errorMessage(err, firstTry) {
        if (firstTry) {
            this.log.error(`[XSense] Fatal error starting Python | ${err} .`);
            this.log.error(`[XSense] ------------------------------------------------------`);
        }

        if (err.hasOwnProperty('message')) {
            this.log.error(`[XSense] ${err.message}`);
        } else {
            this.log.error(`[XSense] Python environment could not be initialized.`);
        }

        if (firstTry) {
            this.log.error(`[XSense] Restart the adapter manually.`);
            this.setState('info.connection', false, true, () => {
                this.terminate('[XSense]  terminated', 1);
            });
        }
    }
}

if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new xsenseControll(options);
} else {
    // otherwise start the instance directly
    new xsenseControll();
}
