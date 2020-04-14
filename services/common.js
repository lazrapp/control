const fs = require('fs');
const assert = require('assert');

function isUndefined(value) {
    return typeof value === 'undefined' || value === null;
}

function copyFile(fileSrc, fileDest, cb) {
    var cbCalled = false;

    var rd = fs.createReadStream(fileSrc);
    rd.on("error", function (err) {
        err.fileName = fileSrc;
        done(err);
    });

    var wr = fs.createWriteStream(fileDest);
    wr.on("error", function (err) {
        err.fileName = fileDest;
        done(err);
    });

    wr.on("close", function (ex) {
        done();
    });
    rd.pipe(wr);

    function done(err) {
        if (!cbCalled) {
            cb(err);
            cbCalled = true;
        }
    }
}

function downloadFile(fileUrlStr, fileDest, cb) {
    var supportedProtocols = {
        "https:": https
    };

    var fileUrl = url.parse(fileUrlStr);
    var protocolLib = supportedProtocols[fileUrl.protocol];

    if (!isUndefined(protocolLib)) {
        var file = fs.createWriteStream(fileDest);
        protocolLib.get(fileUrlStr, function (res) {
            if (res.statusCode !== 200) {
                var err = new Error('file download failed');
                err.fileName = fileDest;
                err.statusCode = res.statusCode;
                return cb(err);
            }

            res.on('data', function (data) {
                file.write(data);
            }).on('end', function () {
                file.end();
                cb();
            });
        }).on('error', function (err) {
            console.log('downloadFile error');
            fs.unlink(fileDest);
            err.fileName = fileDest;
            cb(err);
        });
    }
    else {
        copyFile(fileUrl.pathname, fileDest, cb);
    }
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
    isUndefined: isUndefined,
    copyFile: copyFile,
    downloadFile: downloadFile
};