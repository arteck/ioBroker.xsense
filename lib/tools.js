'use strict';

/**
 * Prüft ob ein Wert gültiges JSON ist.
 *
 * @param {*} item
 * @returns {boolean}
 */
function isJson(item) {
    let value = typeof item !== 'string' ? JSON.stringify(item) : item;
    try {
        value = JSON.parse(value);
    } catch (e) {
        return false;
    }
    return typeof value === 'object' && value !== null;
}

module.exports = { isJson };
