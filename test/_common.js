assert = require('assert');
haredis = require('../');
async = require('async');
spawn = require('child_process').spawn;
rimraf = require('rimraf');
mkdirp = require('mkdirp');
idgen = require('idgen');

servers = {};
ports = [6380, 6381, 6382];
testId = idgen(4);

makeServer = function (port, cb) {
  var dir = '/tmp/haredis-test-' + testId + '/' + port;
  mkdirp(dir, function (err) {
    if (err) return cb(err);
    var child = spawn('redis-server', ['--port', port, '--dir', dir, '--slave-read-only', 'no']);
    var started = false;
    child.stdout.on('data', function (chunk) {
      if (~String(chunk).indexOf('The server is now ready')) {
        started = true;
        cb(null, child);
      }
    });
    child.stderr.pipe(process.stderr);
    setTimeout(function () {
      if (!started) throw new Error('redis-server on port ' + port + ' failed to start');
    }, 10000);
  });
};

makeServers = function (cb) {
  var tasks = {};
  ports.forEach(function (port) {
    tasks[port] = makeServer.bind(null, port);
  });

  async.parallel(tasks, function (err, results) {
    assert.ifError(err);
    servers = results;
    cb();
  });
};

process.on('exit', function () {
  Object.keys(servers).forEach(function (port) { servers[port].kill(); });
  rimraf.sync('/tmp/haredis-test-' + testId);
});

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
