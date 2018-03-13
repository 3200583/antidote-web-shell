'use strict';

const antidote = require('antidote_ts_client');
const express = require('express');
const path = require('path');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const compression = require('compression');
const helmet = require('helmet');

const conf = require('./config');

const DEBUG = true;
function log(...args) {
    if (DEBUG) {
        console.log(...args);
    }
}

const app = express();

app.use(helmet());
app.use(compression()); // Compress all routes
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const viewPath = __dirname + '/views/';

// Cache of partition info
// XXX change this if the web server is replicated
var partitionInfo = new Map();
for (i = 1; i <= conf.antidote.length; i++) {
    partitionInfo.set(i, true);
}

// Initialize Antidote clients
var atdClis = [];
for (var i in conf.antidote) {
    atdClis.push(antidote.connect(conf.antidote[i].port, conf.antidote[i].host));
}

/* Static web page routing. */
var staticRouter = express.Router();
staticRouter.get('/', function (req, res, next) {
    res.sendFile(viewPath + 'index.html');
});
app.use("/", staticRouter);

/* API routing. */
var apiRouter = express.Router();

// Document API
apiRouter.route('/:rep_id/doc/:filename')
    .get(function(req, res) {
        res.json({status : 'OK', cont: "SUCCESS BIXENTE"});
    })
    .put(function(req, res) {
        let repId = parseInt(req.params.rep_id);
        let docId = req.params.filename;
        let connection = atdClis[repId-1];
        let doc = connection.map(docId);
        var update = [];
        Object.keys(req.body).forEach(function(key, index) {
            let value = req.body[key];
            if (Array.isArray(value)) {
                log("ARRAY", value);
                update.push(doc.set(key).addAll(value));
            } else if (typeof value === 'string') {
                log("STRING", value);
                update.push(doc.register(key).set(value));
            } else if (value != null && typeof value === 'object') {
                log("JSON", value);
            }
        });
        connection.update(update).then(content => {
            res.json({status: 'OK', cont: 'SUCCESS BIXENTE'});            
        });
    });

// Map API
apiRouter.route('/:rep_id/map/:map_id/')
    .get(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        let mapId = req.params.map_id;
        let map = atdClis[repId-1].map(mapId);
        map.read().then(content => {
            log('Get', mapId, 'from replica', repId);
            res.json({status : 'OK', cont: content.toJsObject()});
        });
    });

apiRouter.route('/:rep_id/map/:map_id/key/:key_id')
    .put(function(req, res) {
        let repId = parseInt(req.params.rep_id);
        let mapId = req.params.map_id;
        let keyId = req.params.key_id;
        let op = req.body.op;
        let value = req.body.value;
        let connection = atdClis[repId-1];
        let map = connection.map(mapId);
        var update = null;
        var tmp = 0;
        switch(op) {
            case 'add':
                update = map.set(keyId).add(value)
                break;
            case 'remove':
                update = map.set(keyId).remove(value);
                break;
            case 'inc':
                tmp = value === 'undefined' ? 1: value;
                update = map.counter(keyId).increment(tmp)
                break;
            case 'dec':
                tmp = value === 'undefined' ? 1: value;
                update = map.counter(keyId).decrement(tmp);
                break;
            case 'set':
                update = map.register(keyId).set(value);
                break;
        }
        connection.update(update).then(resp => {
            log(op, value, 'to', keyId, 'on replica', repId)
            res.json({ status: 'OK' });
        });
    });
apiRouter.route('/:rep_id/map/:map_id/type/:type/key/:key_id')
    .delete(function(req, res) {
        let repId = parseInt(req.params.rep_id);
        let mapId = req.params.map_id;
        let type  = req.params.type;
        let keyId = req.params.key_id;
        let connection = atdClis[repId-1];
        let map = connection.map(mapId);
        var remove = null;
        switch(type) {
            case 'count':
                remove = map.remove(map.counter(keyId));
                break;
            case 'set':
                remove = map.remove(map.set(keyId));
                break;
            case 'reg':
                remove = map.remove(map.register(keyId));
                break;
        }
        connection.update(remove).then(resp => {
            log('Delete', keyId, 'from', mapId, 'on replica', repId)
            res.json({ status : 'OK' });
        });
    });

// Set API
apiRouter.route('/:rep_id/set/:set_id')
    .get(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var setId = req.params.set_id;
        atdClis[repId-1].set(setId).read().then(content => {
            log('Get', setId, 'from replica', repId);
            res.json({ status: 'OK', cont: content });
        });
    })
    .put(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var setId = req.params.set_id;
        var value = req.body.value;
        atdClis[repId-1].update(
            atdClis[repId-1].set(setId).add(value)
        ).then(resp => {
            log('Add', value, 'to', setId, 'on replica', repId)
            res.json({ status: 'OK' });
        });
    })
    .delete(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var setId = req.params.set_id;
        var value = req.body.value;
        atdClis[repId-1].update(
            atdClis[repId-1].set(setId).remove(value)
        ).then(resp => {
            log('Remove', value, 'from', setId, 'on replica', repId)
            res.json({ status: 'OK' });
        });
    });

// Counter API
apiRouter.route('/:rep_id/count/:counter_id')
    .get(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var counterId = req.params.counter_id;
        atdClis[repId-1].counter(counterId).read().then(content => {
            log('Get', counterId, 'from replica', repId);
            res.json({ status: 'OK', cont: content });
        });
    })
    .put(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var counterId = req.params.counter_id;
        atdClis[repId-1].update(
            atdClis[repId-1].counter(counterId).increment(1)
        ).then(resp => {
            log('Increment', counterId, 'on replica', repId)
            res.json({ status: 'OK' });
        });
    })
    .delete(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var counterId = req.params.counter_id;
        atdClis[repId-1].update(
            atdClis[repId-1].counter(counterId).increment(-1)
        ).then(resp => {
            log('Decrement', counterId, 'on replica', repId)
            res.json({ status: 'OK' });
        });
    });

// Network partition API
apiRouter.route('/:rep_id/part')
    .get(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        var value = partitionInfo.get(repId) ? 'ON' : 'OFF';
        res.json({ status: value, rep: repId });
    })
    .put(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        if (!partitionInfo.get(repId)) {
            log('Partition replica', repId, 'already set');
            res.json({ status: 'OK', rep: repId });
        } else {
            spawn(conf.partitionCmd, ['create', repId])
                .on('exit', function (code) {
                    if (code == 0) {
                        log('Partition replica', repId);
                        partitionInfo.set(repId, false);
                        res.json({ status: 'OK', rep: repId });
                    }
                });
        }
    })
    .delete(function (req, res) {
        let repId = parseInt(req.params.rep_id);
        if (partitionInfo.get(repId)) {
            log('Partition replica', repId, 'already removed');
            res.json({ status: 'OK', rep: repId });
        } else {
            spawn(conf.partitionCmd, ['remove', repId])
                .on('exit', function (code) {
                    if (code == 0) {
                        log('Remove partition over replica', repId);
                        partitionInfo.set(repId, true);
                        res.json({ status: 'OK', rep: repId });
                    }
                });
        }
    });

app.use("/api", apiRouter);

/* Default routing. */
app.use("*", function (req, res) {
    res.sendFile(viewPath + "404.html");
});

module.exports = app;
