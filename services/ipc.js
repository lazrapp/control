const ipc = require('node-ipc');
const shell = require('./shell');
const emitter = require('./emitter');

const serverName = 'lazr-control';

let clients = {};

let ipcServer = new ipc.IPC;

ipcServer.config.id = serverName;
ipcServer.serve(() => {
    shell.exec(`chmod ugo+rw ${ipcServer.server.path}`); // allow clients other than root to access this IPC server

    ipcServer.server
        .on('ident', (package, socket) => {
            clients[package] = socket;
        })
        .on('state', (data, socket) => {
            let {package, state} = JSON.parse(data.toString());
            emitter.emit(`ipc::state`, { package, state });
        });
    // TODO: handle disconnects, or throw the thing into the bin and replace
});
ipcServer.server.start();

module.exports = {
    server: ipcServer.server,
    emit: (type, target, message) => {
        let socket = clients[target];
        ipcServer.server.emit(socket, type, message);
    }
};