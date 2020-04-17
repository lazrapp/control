const _ = require('lodash');

const emitter = require('../services/emitter');
const shell = require('../services/shell');
const common = require('../services/common');
const logger = require('../services/logger');

const storage = require('./jobs/storage');

function get({iot, client}) {
    return new Promise((resolve, reject) => {
        let shadow = (msg) => {
            emitter.removeListener(`iot::$aws/things/${client}/shadow/get/rejected`, shadow);
            emitter.removeListener(`iot::$aws/things/${client}/shadow/get/accepted`, shadow);

            return (!msg.timestamp) ? resolve(null) : resolve(msg);
        };

        emitter.once(`iot::$aws/things/${client}/shadow/get/rejected`, shadow);
        emitter.once(`iot::$aws/things/${client}/shadow/get/accepted`, shadow);

        iot.publish(`$aws/things/${client}/shadow/get`, JSON.stringify({}));
    });
}

function update({ iot, client, data }) {
    logger.verbose('Updating thing shadow');
    return iot.publish(`$aws/things/${client}/shadow/update`, JSON.stringify(data));
}

/*function onPackageStart({ iot, client, data }) {
    let { id, pid, ts } = data;

    let state = {};
    _.set(state, `state.reported._runtime[${id}]`, { pid, ts });

    return update({ iot, client: client, data: state });
}

function onPackageStop({ iot, client, data }) {
    let { id } = data;

    let state = {};
    _.set(state, `state.reported._runtime[${id}]`, null);

    return update({ iot, client: client, data: state });
}*/

module.exports.init = async ({iot, auth}) => {
    let shadow = await get({ iot, client: auth.client });

    let swdata = await shell.sw;
    let hwdata = await shell.hw;
    let ipdata = await shell.ip;

    let sys = {
        sw: {
            id: swdata['ID'],
            id_like: swdata['ID_LIKE'],
            version_codename: swdata['VERSION_CODENAME'],
            version_id: swdata['VERSION_ID']
        },
        hw: {
            revision: hwdata,
            type: 'rpi'
        },
        ip: ipdata.trim()
    };

    let packages = storage.packages.list();
    let installedPackages = {};
    Object.keys(packages).forEach(key => {
        installedPackages[key] = packages[key].installed;
    });

    let data = {
        state: {
            reported: {
                _sys: sys,
                _installed: installedPackages
            }
        }
    };

    if (shadow === null) {
        return update({ iot, client: auth.client, data });
    } else if (!common.comparison(sys, shadow.state.reported._sys)) {
        return update({ iot, client: auth.client, data });
    }

    // fire up listeners
    /*emitter.on('package::started', data => onPackageStart({ iot, client: auth.client, data }));
    emitter.on('package::stopped', data => onPackageStop({ iot, client: auth.client, data }));*/

    logger.verbose('Shadow service ready');

    return {
        update: (data) => {
            return update({ iot, client: auth.client, data });
        }
    };
};