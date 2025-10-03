const utils = require('@iobroker/adapter-core');
const tools = require('./lib/tools');
const Json2iobXSense = require('./lib/json2iob');
const path = require('path');

global.fetch = require('node-fetch-commonjs');

let _outputBuffer = Buffer.alloc(0);

let index = 0;
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
            this.log.info('Start X-Sense...');

            await this.json2iob.createStaticDeviceObject();

            if (this.config.userEmail == '') {
                this.log.error('Check Settings. No Username set');
                loginGo = false;
            }
            if (this.config.userPassword == '') {
                this.log.error('Check Settings. No Password set');
                loginGo = false;
            }

            if (loginGo) {
                this.callPython = (await this.getState('info.callPython'))?.val;
                if (this.config.isWindowsSystem) {
                    this.callPython = 'python';
                }

                this.setAllAvailableToFalse();
                this.python = await this.setupXSenseEnvironment(true);

                if (this.python) {
                    const resp = await this.callLogin(this.config.userEmail, this.config.userPassword);

                    if (resp) {
                        this.setState('info.connection', true, true);
                        this.startIntervall();
                    }
                }
            }
        } catch (err) {
            this.setState('info.connection', false, true);
            this.log.error(`Error : ${err.message}`);
            return;
        }
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
            } else {
                this.log.error(`[XSense] No data received from bridge: ${response}`);
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
            const scriptPath = path.join(__dirname, 'python', 'run_xsense.py');
            const proc = this.python(this.callPython, [scriptPath, email, password]);

            let finished = false; // Guard-Flag
            let output = Buffer.alloc(0);

            const timeout = this.setTimeout(() => {
                if (finished) return;
                finished = true;

                this.log.error(
                    `[XSense] callLogin timeout nach ${this.config.pythonTimeout}ms – Prozess wird beendet`,
                );
                proc.kill('SIGKILL');
                reject(new Error(`[XSense] callLogin Timeout nach ${this.config.pythonTimeout}ms`));
            }, 1000 * this.config.pythonTimeout);

            proc.stdout?.on('data', chunk => {
                output = Buffer.concat([output, chunk]);
                this.log.debug(`[XSense] callLogin received ${chunk.length} bytes`);
                this.log.debug(`[XSense] callLogin : ${chunk.toString()}`);
            });

            proc.stdout?.on('end', () => {
                if (finished) return;
                finished = true;

                this.clearTimeout(timeout);
                _outputBuffer = output; // Pickle zwischenspeichern
                this._loginInProgress = false;
                this.log.debug(`[XSense] Pickle Bytes length: ${output.length}`);
                resolve(true);
            });

            proc.stderr?.on('data', data => {
                if (finished) return;
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
                if (finished) return;
                finished = true;

                this.log.debug(`[XSense] total Pickle Bytes received: ${output.length}`);
                index = 0;
                resolve(result);
            });

            proc.stderr.on('data', err => {
                if (finished) return;
                index = 0;
                finished = true;
                reject(new Error(`process_pickle error: ${err.toString()}`));
            });
        });

    }

    async onStateChange(id, state) {
        if (state) {
            this.log.debug(`New Event for state: ${JSON.stringify(state)}`);
            this.log.debug(`ID: ${JSON.stringify(id)}`);

            const tmpControl = id.split('.')[3];

            try {
                switch (tmpControl) {
                    case 'forceRefresh':
                        await this.datenVerarbeiten(false);
                        break;
                    default:
                        this.log.error('No command for Control found');
                }
            } catch (err) {
                this.log.error(`Error onStateChange ${err}`);
            }
        }
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
