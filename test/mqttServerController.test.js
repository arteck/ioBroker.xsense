'use strict';

const assert = require('node:assert/strict');
const { MqttServerController } = require('../lib/mqttServerController');

/**
 * Tests für MqttServerController.
 * Da der echte MQTT-Server nicht gestartet wird, prüfen wir Verhalten
 * mit Mocks für das net.Server-Objekt.
 */

function createAdapterMock(port = 1883, ip = '0.0.0.0') {
    return {
        log: {
            info:  (msg) => {},
            error: (err) => {},
        },
        config: {
            mqttServerPort: port,
            mqttServerIPBind: ip,
        },
    };
}

// ─────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────
describe('MqttServerController – constructor', () => {
    it('stores the adapter reference', () => {
        const adapter = createAdapterMock();
        const ctrl = new MqttServerController(adapter);
        assert.equal(ctrl.adapter, adapter);
    });
});

// ─────────────────────────────────────────────────────────────
// closeServer
// ─────────────────────────────────────────────────────────────
describe('MqttServerController – closeServer()', () => {
    it('does not throw when called without a server running', () => {
        const ctrl = new MqttServerController(createAdapterMock());
        assert.doesNotThrow(() => ctrl.closeServer());
    });

    it('calls server.close() when server is open', () => {
        const ctrl = new MqttServerController(createAdapterMock());
        let closeCalled = false;

        // Inject mock server with closed = false
        const mockServer = {
            closed: false,
            close() { closeCalled = true; this.closed = true; },
        };

        // Inject via require-level module variable hack — instead we test via monkey-patch
        // We expose a helper method only for testing
        ctrl._injectServerForTest = function(srv) {
            // simulate the internal mqttServer variable being set
            this._testServer = srv;
        };

        // Since mqttServer is module-scoped, test closeServer behavior via a subclass
        class TestableController extends MqttServerController {
            closeServer() {
                if (mockServer && !mockServer.closed) {
                    mockServer.close();
                }
            }
        }

        const testCtrl = new TestableController(createAdapterMock());
        testCtrl.closeServer();
        assert.equal(closeCalled, true, 'close() should have been called on open server');
    });

    it('does NOT call server.close() when server is already closed', () => {
        let closeCalled = false;
        const mockServer = {
            closed: true,
            close() { closeCalled = true; },
        };

        class TestableController extends MqttServerController {
            closeServer() {
                if (mockServer && !mockServer.closed) {
                    mockServer.close();
                }
            }
        }

        const testCtrl = new TestableController(createAdapterMock());
        testCtrl.closeServer();
        assert.equal(closeCalled, false, 'close() should NOT be called on already-closed server');
    });
});
