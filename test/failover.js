describe('failover', function () {
  before(makeServers);

  var client, masterPort, newMasterPort;
  it('create client', function (done) {
    client = createClient();

    var latch = 2;
    client.once('connect', function () {
      masterPort = client.master.port;
      if (!--latch) done();
    });

    client.waitFor([
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
    client.waitFor([
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
    client.waitFor('reorientating \\(evaluating 127.0.0.1:' + masterPort + '\\) in 2000ms', done);
    makeServer(masterPort, function (err, server) {
      assert.ifError(err);
      servers[masterPort] = server;
    });
  });

  it('old master is made into slave', function (done) {
    // @todo: waitFor message that masterPort made into slave
    client.waitFor([
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
