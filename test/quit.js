describe('quit', function () {
  before(makeServers);
  after(shutdownServers);

  describe('clustered', function () {
    var client, ended = false;
    it('create client', function (done) {
      client = createClient();
      client.once('connect', done);
    });
    it('kill master', function (done) {
      servers[client.master.port].kill();
      delete servers[client.master.port];
      setTimeout(done, 2000);
    });
    it('quit', function (done) {
      client.once('end', function () {
        ended = true;
      });
      client.quit(done);
    });
    it('ended', function (done) {
      setTimeout(function () {
        assert(ended);
        done();
      }, 1000);
    });
  });

  describe('single', function () {
    var client, ended = false;
    it('create client', function (done) {
      client = haredis.createClient();
      client.once('connect', done);
    });
    it('quit', function (done) {
      client.once('end', function () {
        ended = true;
      });
      client.quit(done);
    });
    it('ended', function (done) {
      setTimeout(function () {
        assert(ended);
        done();
      }, 1000);
    });
  });
});

describe('end', function () {
  before(makeServers);
  after(shutdownServers);

  describe('clustered', function () {
    var client;
    it('create client', function (done) {
      client = createClient();
      client.once('connect', done);
    });
    it('kill master', function (done) {
      servers[client.master.port].kill();
      delete servers[client.master.port];
      setTimeout(done, 2000);
    });
    it('end', function (done) {
      client.once('end', done);
      client.end();
    });
  });

  describe('single', function () {
    var client;
    it('create client', function (done) {
      client = haredis.createClient();
      client.once('connect', done);
    });
    it('quit', function (done) {
      client.once('end', done);
      client.end();
    });
  });
});