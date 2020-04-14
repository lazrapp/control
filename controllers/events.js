const _ = require('lodash');

const emitter = require('../services/emitter');

const services = {
    getSystemInfo: () => {
        const { installedPackages } = require('./jobs');

        let packageNames = installedPackages.map(package => package.packageName);

        let res = {
            installedPackages: JSON.stringify(packageNames),
            arch: process.arch,
            nodeVersion: process.version,
            cwd: process.cwd(),
            platform: process.platform,
            title: process.title,
            uptime: process.uptime()
        };

        emitter.emit('publish::iot', {
            topic: 'systemInfo',
            msg: res
        });
    }
};

// expose services to global, private and other controllers

const controllers = {
    global: {
        getSystemInfo: services.getSystemInfo
    },
    private: {
        getSystemInfo: services.getSystemInfo
    }
};

// map messages to internal controllers

/* message structure example
{
    function: "getSystemInfo",
    attributes: []
}
*/

function messageRouter(type, payload) {
    let { topic, attributes } = payload;

    let fn = _.get(controllers, `${type}.${topic}`, null);

    if (fn === null) return console.error(`Unsupported ${type} function call`, topic);

    fn({ message: attributes });
}

module.exports = ({iot, auth}) => {
    let shadow = require('./shadow');
    let jobs = require('./jobs');
    let tunnel = require('./tunnel');

    let initChannels = [
        `devices/${auth.client}`,
        `devices/$global`,
        `$aws/things/${auth.client}/shadow/delta`,
        `$aws/things/${auth.client}/shadow/get/accepted`,
        `$aws/things/${auth.client}/shadow/get/rejected`,
        `$aws/things/${auth.client}/tunnels/notify`
    ];

    let channel = {
        iot: {
            private: initChannels[0],
            global: initChannels[1],
            tunnel: initChannels[5]
        },
        internal: {}
    };

    for (const key in channel.iot) {
        channel.internal[key] = `iot::${channel.iot[key]}`;
    }
    
    let events = {
        onConnect: () => {
            console.log('<<', 'connected');
            iot.subscribe(initChannels);
            
            // ready to go, start the dependencies
            console.log('<<', 'ready');
            shadow.init({ iot, auth });
            jobs.init({ iot, auth });
            tunnel.init({ channel: channel.internal.tunnel });
        },
        onClose: () => {
            console.log('<<', 'closed');
        },
        onReconnect: () => {
            console.log('<<', 'reconnect');
        },
        onOffline: () => {
            console.log('<<', 'offline');
        },
        onError: (err) => {
            throw new Error(err);
        },
        onMessage: (topic, payload) => {
            emitter.emit(`iot::${topic}`, JSON.parse(payload.toString()));
        }
    };

    // mqtt message routing
    iot
        .on('connect', events.onConnect)
        .on('close', events.onClose)
        .on('reconnect', events.onReconnect)
        .on('offline', events.onOffline)
        .on('error', events.onError)
        .on('message', events.onMessage);

    // internal message routing
    emitter.on(channel.internal.private, (payload) => messageRouter("private", payload));
    emitter.on(channel.internal.global, (payload) => messageRouter("global", payload));

    // message emitter
    emitter.on('publish::iot', ({ topic, msg }) => {
        iot.publish(`${channel.iot.private}/${topic}`, JSON.stringify(msg || {}));
    });
};