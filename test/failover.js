describe('failover', function () {
  before(makeServers);
  after(shutdownServers);

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

  it('increment counter', function (done) {
    client.INCR('test-counter', done);
  });

  it('wait a bit for replication', function (done) {
    setTimeout(done, 1500);
  });

  it('check counter on nodes', function (done) {
    var latch = 3;
    assert.equal(client.up.length, latch);
    client.up.forEach(function (node) {
      node.client.GET('test-counter', function (err, counter) {
        assert.ifError(err);
        assert.equal(counter, 1);
        if (!--latch) done();
      });
    });
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

  it('check counter', function (done) {
    var latch = 2;
    assert.equal(client.up.length, latch);
    client.up.forEach(function (node) {
      node.client.GET('test-counter', function (err, counter) {
        assert.ifError(err);
        assert.equal(counter, 1);
        if (!--latch) done();
      });
    });
  });

  it('client had failed over', function () {
    newMasterPort = client.master.port;
    assert(newMasterPort != masterPort);
    assert(client.ready);
    assert(client.connected);
  });

  it('increment counter again', function (done) {
    client.INCR('test-counter', done);
  });

  it('restart old master', function (done) {
    makeServer(masterPort, function (err, server) {
      assert.ifError(err);
      servers[masterPort] = server;
      done();
    });
  });

  it('old master is made into slave', function (done) {
    // @todo: waitFor message that masterPort made into slave
    client.waitFor([
      'invalid master count: 2',
      'attempting failover!',
      'elected .* as master!',
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

  it('wait a bit for replication', function (done) {
    setTimeout(done, 1500);
  });

  it('get counter', function (done) {
    var latch = 3;
    assert.equal(client.up.length, latch);
    client.up.forEach(function (node) {
      node.client.GET('test-counter', function (err, counter) {
        assert.ifError(err);
        if (counter != 2) console.log('bad counter!', node + '');
        assert.equal(counter, 2);
        if (!--latch) done();
      });
    });
  });
});
