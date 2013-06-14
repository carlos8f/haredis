assert = require('assert');
haredis = require('../');
async = require('async');
spawn = require('child_process').spawn;
exec = require('child_process').exec;
rimraf = require('rimraf');
mkdirp = require('mkdirp');
idgen = require('idgen');
path = require('path');

servers = {};
ports = ['127.0.0.1:6380', 'localhost:6381', 6382];
testId = null;

makeServer = function (port, cb) {
  exec('redis-server --version', function (err, stdout, stderr) {
    assert.ifError(err);
    var version;
    var matches = stdout.match(/Redis server v=(.*) sha=/);
    if (matches) version = matches[1];
    else {
      matches = stdout.match(/version ([^ ]+) /);
      if (matches) version = matches[1];
      else throw new Error('could not detect redis-server version! ' + stdout);
    }
    var dir = '/tmp/haredis-test-' + testId + '/' + port;
    mkdirp(dir, function (err) {
      if (err) return cb(err);
      var conf = 'port ' + port + '\ndir ' + dir + '\n';
      if (!version.match(/^2\.(2|3|4)\./)) conf += 'slave-read-only no\n';
      var child = spawn('redis-server', ['-']);
      var started = false;
      child.stdin.end(conf);
      child.stderr.pipe(process.stderr);
      child.stdout.on('data', function (chunk) {
        if (~String(chunk).indexOf('The server is now ready')) {
          started = true;
          cb(null, child);
        }
      });
      setTimeout(function () {
        if (!started) throw new Error('redis-server on port ' + port + ' failed to start');
      }, 10000);
    });
  });
};

makeServers = function (cb) {
  testId = idgen(4);
  var tasks = {};
  ports.forEach(function (port) {
    if (typeof port === 'string') port = Number(port.split(':')[1]);
    tasks[port] = makeServer.bind(null, port);
  });

  async.parallel(tasks, function (err, results) {
    assert.ifError(err);
    servers = results;
    cb();
  });
};

shutdownServers = function (cb) {
  var latch = Object.keys(servers).length;
  Object.keys(servers).forEach(function (port) {
    servers[port].once('exit', function () {
      if (!--latch && typeof cb === 'function') cb();
    });
    servers[port].kill();
  });
  rimraf.sync('/tmp/haredis-test-' + testId);
  servers = {};
}

process.on('exit', shutdownServers);

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
