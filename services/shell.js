const util = require('util');
const exec = util.promisify(require('child_process').exec);

module.exports = {
    sw: exec('cat /etc/os-release')
        .then(({ stdout }) => stdout.split('\n'))
        .then(res => res.map(line => line.split('=')))
        .then(res => res.reduce((acc, cur, i) => {
            if (cur.length != 2) return acc;
            acc[cur[0]] = cur[1].replace(/^"(.+(?="$))"$/, '$1');
            return acc;
        }, {})),
    hw: exec(`awk '/^Revision/ {sub("^1000", "", $3); print $3}' /proc/cpuinfo`)
        .then(({ stdout }) => stdout.replace(/(\r\n\t|\n|\r\t)/gm, "")), // https://elinux.org/RPi_HardwareHistory
    ip: exec(`hostname --all-ip-addresses`)
        .then(({ stdout }) => stdout.replace(/(\r\n\t|\n|\r\t)/gm, "")),
    exec: (command) => exec(command).then(({ stdout }) => stdout.replace(/(\r\n\t|\n|\r\t)/gm, ""))
};