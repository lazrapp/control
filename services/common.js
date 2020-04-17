const assert = require('assert');

function isUndefined(value) {
    return typeof value === 'undefined' || value === null;
}

module.exports = {
    comparison: (o1, o2) => {
        try {
            assert.deepEqual(o1, o2);
            return true;
        } catch (err) {
            return false;
        }
    },
    isUndefined: isUndefined
};