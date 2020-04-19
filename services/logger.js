const { createLogger, format, transports } = require('winston');

const logger = createLogger({
    format: format.combine(
        format.splat(),
        format.simple()
    ),
    level: 'verbose',
    transports: [
        new transports.File({ filename: 'error.log', level: 'error' }),
        new transports.Console()
    ]
});

module.exports = logger;