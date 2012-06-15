var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , dns = require('dns')
  ;

function Node(spec, options) {
  var self = this;
  this.host = spec.host;
  this.port = spec.port;

  options = options || {};
  if (typeof options.no_ready_check == 'undefined') {
    options.no_ready_check = true;
  }
  this.options = {};
  Object.keys(options).forEach(function(k) {
    self.options[k] = options[k];
  });

  // Resolve host, to prevent false duplication
  Node.resolveHost(this.host, function(err, host) {
    if (err) {
      return self.emit('error', err);
    }
    self.host = host;
    self.connect();
  });
}
util.inherits(Node, EventEmitter);

// Static method
Node.resolveHost = function(host, cb) {
  dns.lookup(host, 4, cb);
};

Node.parseInfo = function(reply) {
  var lines = reply.toString().split("\r\n"), obj = {};

  lines.forEach(function(line) {
    var parts = line.split(':');
    if (parts[1]) {
      obj[parts[0]] = parts[1];
    }
  });

  obj.versions = [];
  obj.redis_version.split('.').forEach(function(num) {
    obj.versions.push(+num);
  });
  return obj;
};

Node.prototype.connect = function() {
  this.setStatus('initializing');
  this.client = redis.createClient(this.port, this.host, this.options);
  var self = this;
  this.client.on('error', function(err) {
    self.emit('error', err);
    self.setStatus('down');
  });
  this.client.on('connect', function() {
    self.client.CONFIG('GET', 'slave-read-only', function(err, reply) {
      if (err) {
        return self.emit('error', err);
      }
      if (reply[1] === 'no') {
        self.setStatus('up');
      }
      else {
        console.warn('WARNING! ' + self.toString() + ' has slave-read-only mode ON, which breaks haredis failover! slave-read-only automatically turned OFF.');
        self.client.CONFIG('SET', 'slave-read-only', 'no', function(err, reply) {
          if (err) {
            return self.emit('error', err);
          }
          self.setStatus('up');
        });
      }
    });
  });
};

Node.prototype.setStatus = function(status) {
  this.status = status;
  this.emit(status);
};

Node.prototype.toString = function() {
  return this.host + ':' + this.port;
};

module.exports = Node;