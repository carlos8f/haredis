var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  ;

function Node(options, clientOptions) {
  this.host = options.host;
  this.port = options.port;
  this.failing = false;
  clientOptions = clientOptions || {};
  this.pingInterval = clientOptions.pingInterval || 10000;
  this.clientOptions = clientOptions;
  this.connect();
}
inherits(Node, EventEmitter);

Node.prototype.connect = function() {
  this.client = redis.createClient(this.port, this.host, this.clientOptions);
  var self = this;
  this.client.on('error', function(err) {
    self.emit('error', err);
    self.failing = true;
  });
  this.client.on('connect', function() {
    self.failing = false;
  });
  this.client.on('ready', function() {
    var old_role = self.role;
    self.role = self.client.server_info.role;
    if (self.role != old_role) {
      self.emit('role');
    }
    this.ping();
  });
};

Node.prototype.ping = function() {
  var self = this;
  var start = Date.now();
  this.client.PING(function(err) {
    if (err) {
      return self.emit('error', err);
    }
    self.latency = Date.now() - start;
    self.failing = false;
    self.emit('ping', self.latency);
    setTimeout(function() {
      self.ping();
    }, self.pingInterval);
  });
};

Node.prototype.toString = function() {
  return this.host + ':' + this.port;
}