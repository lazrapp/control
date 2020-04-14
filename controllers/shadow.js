const emitter = require('../services/emitter');
const shell = require('../services/shell');
const common = require('../services/common');

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

function update({iot, client, data}) {
    console.log('shadow.update', client, data);
    return iot.publish(`$aws/things/${client}/shadow/update`, JSON.stringify(data));
}

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
        ip: ipdata
    };

    let reported = {
        state: {
            reported: {
                _sys: sys
            }
        }
    };

    if (shadow === null) {
        return update({ iot, client: auth.client, reported });
    } else if (!common.comparison(sys, shadow.state.reported._sys)) {
        return update({ iot, client: auth.client, reported });
    }

    return {
        get,
        update
    }; 
};