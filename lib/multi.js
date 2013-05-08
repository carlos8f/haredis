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
  if (this.client.ready) {
    redis.Multi.prototype.exec.call(this, callback);
    incrOpcounter();
  }
  else {
    this.client.once('ready', function() {
      redis.Multi.prototype.exec.call(self, callback);
      incrOpcounter();
    });
  }

  // Increment to opcounter for every write operation in the queue.
  function incrOpcounter() {
    var incr = 0;
    self.queue.forEach(function(args) {
      if (!self.client.isRead(args[0])) {
        incr++;
      }
    });
    if (incr) {
      self.client.incrOpcounter(incr, function(err) {
        if (err) {
          self.client.master.emit('error', err);
        }
      });
    }
  }
};

module.exports = HAMulti;