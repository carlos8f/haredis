describe('failover', function () {
  var servers
    , ports = [6380, 6381, 6382]
    , testId = idgen(4)
    , tail = ''

  function log () {
    var args = [].slice.call(arguments);
    var line = args.join(' ') + '\n';
    tail += line;
    //process.stdout.write(line);
  };

  function waitFor (pattern, cb) {
    if (Array.isArray(pattern)) {
      var list = pattern.slice();
      var latch = list.length;
      (function doNext () {
        var pat = list.shift();
        waitFor(pat, function () {
          if (!--latch) cb();
          else doNext();
        });
      })();
      return;
    }
    var timeout, found = false;
    (function search () {
      if (found) return;
      tail.split('\n').forEach(function (line, idx) {
        if (found) return;
        if (line.match(pattern)) {
          found = true;
          tail = tail.split('\n').slice(idx).join('\n');
          cb();
        }
      });
      if (!found) timeout = setTimeout(search, 500);
    })();
    setTimeout(function () {
      clearTimeout(timeout);
      if (!found) throw new Error('timed out waiting for `' + pattern + '`');
    }, 30000);
  }

  function makeServer (port, cb) {
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
  }

  process.on('exit', function () {
    if (servers) Object.keys(servers).forEach(function (port) { servers[port].kill(); });
    rimraf.sync('/tmp/haredis-test-' + testId);
  });

  before(function (cb) {
    var tasks = {};
    ports.forEach(function (port) {
      tasks[port] = makeServer.bind(null, port);
    });

    async.parallel(tasks, function (err, results) {
      assert.ifError(err);
      servers = results;
      cb();
    });
  });

  var client, masterPort, newMasterPort;
  it('create client', function (done) {
    client = haredis.createClient(ports);
    // redirect logging
    client.warn = client.error = client.log = log;

    var latch = 2;
    client.once('connect', function () {
      masterPort = client.master.port;
      if (!--latch) done();
    });

    waitFor([
      'invalid master count: 3',
      'elected .* as master!',
      'making .* into a slave...',
      'making .* into a slave...'
    ], function () {
      if (!--latch) done();
    });
  });

  it('set some data', function (done) {
    var latch = 200;
    for (var i = 0; i < latch; i++) {
      (function (i) {
        client.SET('my-test-' + i, i, function (err) {
          assert.ifError(err);
          if (!--latch) done();
        });
      })(i);
    }
  });

  it('wait a bit for replication', function (done) {
    setTimeout(done, 1500);
  });

  it('kill master', function (done) {
    waitFor([
      'MASTER connection dropped, reconnecting...',
      'Error: .* connection dropped and reconnection failed!',
      'MASTER is down!',
      'reorientating',
      'invalid master count: 0',
      'orientate complete, using .* as master'
    ], done);
    servers[masterPort].kill();
  });

  it('get the data anyway', function (done) {
    client.GET('my-test-199', function (err, data) {
      assert.ifError(err);
      assert.equal(data, '199');
      done();
    });
  });

  it('client had failed over', function () {
    newMasterPort = client.master.port;
    assert(newMasterPort != masterPort);
    assert(client.ready);
    assert(client.connected);
  });

  it('set new data', function (done) {
    var latch = 200;
    for (var i = 0; i < latch; i++) {
      (function (i) {
        i += 200;
        client.SET('my-test-' + i, i, function (err) {
          assert.ifError(err);
          if (!--latch) done();
        });
      })(i);
    }
  });

  it('restart old master', function (done) {
    waitFor('reorientating \\(evaluating 127.0.0.1:' + masterPort + '\\) in 2000ms', done);
    makeServer(masterPort, function (err, server) {
      assert.ifError(err);
      servers[masterPort] = server;
    });
  });

  it('old master is made into slave', function (done) {
    // @todo: waitFor message that masterPort made into slave
    waitFor([
      'invalid master count: 2',
      'attempting failover!',
      'elected .* as master!',
      'making 127.0.0.1:' + masterPort + ' into a slave...',
      'orientate complete'
    ], done);
  });

  it('cluster in reasonable state', function () {
    assert.equal(client.nodes.length, 3);
    assert.equal(client.up.length, 3);
    var masterCount = 0;
    client.nodes.forEach(function (node) {
      if (node.port === masterPort) assert.equal(node.role, 'slave');
      if (node.role === 'master') masterCount++;
    });
    assert.equal(masterCount, 1);
  });

  it('get new data', function (done) {
    client.GET('my-test-399', function (err, data) {
      assert.ifError(err);
      assert.equal(data, '399');
      done();
    });
  });
});
