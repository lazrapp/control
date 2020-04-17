const fs = require('fs');
const aws = require('./services/aws');
const logger = require('./services/logger');

let auth = {
    ca: fs.readFileSync('./auth/ca.crt'),
    cert: fs.readFileSync('./auth/client.crt'),
    key: fs.readFileSync('./auth/client.key'),
    client: fs.readFileSync('./auth/name').toString().replace(/(\r\n\t|\n|\r\t)/gm, ""),
    host: fs.readFileSync('./auth/host').toString().replace(/(\r\n\t|\n|\r\t)/gm, "")
};

const start = async (options) => {
    let iot = aws.iot.init(options);
    let events = require('./controllers/events')({ iot, auth });
};

start(auth);
logger.info('Started service');