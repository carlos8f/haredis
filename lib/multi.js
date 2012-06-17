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
  }
  else {
    this.client.once('ready', function() {
      redis.Multi.prototype.exec.call(self, callback);
    });
  }
};

module.exports = HAMulti;