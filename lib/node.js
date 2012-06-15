var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , dns = require('dns')
  ;

function Node(spec, options) {
  var self = this;
  // Resolve host, to prevent false duplication
  dns.lookup(spec.host, 4, function(err, address) {
    if (err) {
      return self.emit('error', err);
    }
    self.host = address;
    self.port = spec.port;
    self.status = 'initializing';
    options = options || {};
    self.pingInterval = options.pingInterval || 10000;
    self.options = {};

    Object.keys(options).forEach(function(k) {
      self.options[k] = options[k];
    });
    self.options = options;
    self.connect();
  });
}
util.inherits(Node, EventEmitter);

Node.prototype.connect = function() {
  this.client = redis.createClient(this.port, this.host, this.options);
  var self = this;
  this.client.on('error', function(err) {
    self.emit('error', err);
    self.setStatus('down');
  });
  this.client.on('connect', function() {
    self.setStatus('up');
  });
  this.client.on('ready', function() {
    self.detectRole(true);
    self.ping();
  });
};

Node.prototype.setStatus = function(status) {
  var old_status = this.status;
  this.status = status;
  if (status != old_status) {
    this.emit('status', status);
  }
};

Node.prototype.detectRole = function(isReadyCheck) {
  var self = this;
  if (isReadyCheck) {
    emitRole(this.client.server_info);
    if (this.client.server_info.role == 'slave') {
      dns.lookup(this.client.server_info.master_host, 4, function(err, address) {
        if (err) {
          return self.emit('error', err);
        }
        var info = self.client.server_info;
        info.master_host = address;
        self.emit('gossip', info);
      });
    }
  }
  else {
    this.client.INFO(function(err, info) {
      if (err) {
        return self.emit('error', err);
      }
      self.setStatus('up');
      emitRole(info);
    });
  }

  function emitRole(info) {
    var old_role = self.role;
    self.role = self.client.server_info.role;
    if (self.role != old_role) {
      self.emit('role');
    }
  }
};

Node.prototype.ping = function() {
  var self = this;
  var start = Date.now();
  this.client.PING(function(err) {
    if (err) {
      return self.emit('error', err);
    }
    var latency = Date.now() - start;
    self.setStatus('up');
    self.emit('ping', latency);
    self.detectRole();
    setTimeout(function() {
      self.ping();
    }, self.pingInterval);
  });
};

Node.prototype.toString = function() {
  return this.host + ':' + this.port;
};

module.exports = Node;