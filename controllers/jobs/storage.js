const fs = require('fs');
const _ = require('lodash');

const emitter = require('../../services/emitter');

const storageFile = './packages.lazr.json';

let storage = {
    runtime: {},
    packages: readFromFile(storageFile)
};

function readFromFile(filepath) {
    let content;
    try {
        content = fs.readFileSync(filepath, { encoding: "utf8" });
        return JSON.parse(content);
    } catch(err) {
        return({});
    } 
} 

function syncToFile() {
    fs.writeFileSync(storageFile, JSON.stringify(storage.packages));
}

module.exports = {
    runtime: {
        list: () => storage.runtime,
        get: (id) => _.get(storage, `runtime[${id}]`),
        set: (id, item) => {
            emitter.emit(`package::started`, { id: id, pid: item.process.pid, ts: +new Date() });
            _.set(storage, `runtime[${id}]`, item)
        },
        remove: (id) => {
            emitter.emit(`package::stopped`, { id: id });
            delete storage.runtime[id];
        }
    },
    packages: {
        list: () => storage.packages,
        get: (id) => _.get(storage, `packages[${id}]`),
        set: (id, item) => {
            emitter.emit(`package::installed`, { id: id });
            _.set(storage, `packages[${id}]`, item);
            syncToFile();
        },
        remove: (id) => {
            emitter.emit(`package::removed`, { id: id });
            delete storage.packages[id];
            syncToFile();
        }
    }
};