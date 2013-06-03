describe('node_redis tests', function () {
  before(makeServers);
  after(shutdownServers);

  it('original node_redis test', function (done) {
    var child = spawn('node', [path.join(__dirname, '..', 'test-singlemode.js')]);
    child.stderr.pipe(process.stderr);
    child.once('exit', function (code) {
      assert.equal(code, 0);
      done();
    });
  });

  it('node_redis test in cluster mode', function (done) {
    var child = spawn('node', [path.join(__dirname, '..', 'test.js')]);
    child.stderr.pipe(process.stderr);
    child.once('exit', function (code) {
      assert.equal(code, 0);
      done();
    });
  });
});
