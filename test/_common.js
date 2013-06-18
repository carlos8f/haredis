assert = require('assert');
haredis = require('../');
async = require('async');
tmp = require('haredis-tmp');
path = require('path');
spawn = require('child_process').spawn;

servers = {};
ports = ['127.0.0.1:6380', 'localhost:6381', 6382];
var shutdown;

shutdownServers = function (done) {
  shutdown(function (err) {
    assert.ifError(err);
    delete shutdown;
    servers = {};
    done();
  });
};

makeServers = function (done) {
  var _ports = ports.map(function (port) {
    return typeof port === 'string' ? Number(port.split(':')[1]) : port;
  });
  tmp(_ports, function (err, p, sd, s) {
    assert.ifError(err);
    shutdown = sd;
    servers = s;
    done();
  });
};

createClient = function () {
  var client = haredis.createClient(ports);
  // redirect logging
  client.warn = client.error = client.log = log;

  client.tail = '';

  function log () {
    var args = [].slice.call(arguments);
    var line = args.join(' ') + '\n';
    client.tail += line;
    //process.stdout.write(line);
  };

  client.waitFor = function (pattern, cb) {
    if (Array.isArray(pattern)) {
      var list = pattern.slice();
      var latch = list.length;
      (function doNext () {
        var pat = list.shift();
        client.waitFor(pat, function () {
          if (!--latch) cb();
          else doNext();
        });
      })();
      return;
    }
    var timeout, found = false;
    (function search () {
      if (found) return;
      client.tail.split('\n').forEach(function (line, idx) {
        if (found) return;
        if (line.match(pattern)) {
          found = true;
          client.tail = client.tail.split('\n').slice(idx).join('\n');
          cb();
        }
      });
      if (!found) timeout = setTimeout(search, 500);
    })();
    setTimeout(function () {
      clearTimeout(timeout);
      if (!found) throw new Error('timed out waiting for `' + pattern + '`');
    }, 30000);
  };

  return client;
};
