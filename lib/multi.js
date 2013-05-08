var redis = require('redis')
  , util = require('util')
  ;

function HAMulti(client, args) {
  redis.Multi.call(this, client, args);
}
util.inherits(HAMulti, redis.Multi);

// Defer execution until ready.
HAMulti.prototype.exec = function(callback) {
  var self = this;
  if (this._client.ready) {
    redis.Multi.prototype.exec.call(this, callback);
    incrOpcounter();
  }
  else {
    this._client.once('ready', function() {
      redis.Multi.prototype.exec.call(self, callback);
      incrOpcounter();
    });
  }

  // Increment to opcounter for every write operation in the queue.
  function incrOpcounter() {
    var incr = 0;
    self.queue.forEach(function(args) {
      if (!self._client.isRead(args[0])) {
        incr++;
      }
    });
    if (incr) {
      self._client.incrOpcounter(incr, function(err) {
        if (err) {
          self._client.master.emit('error', err);
        }
      });
    }
  }
};

module.exports = HAMulti;