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
  var self = this;
  this.setStatus('initializing');
  this.client = redis.createClient(this.port, this.host, this.options);
  this.client.on('error', function(err) {
    self.emit('error', err);
    self.setStatus('down');
  });
  this.client.on('connect', function() {
    self.client.CONFIG('GET', 'slave-read-only', function(err, reply) {
      if (err) {
        return self.emit('error', err);
      }
      if (reply[1] !== 'yes') {
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

  // Maintain a separate pub/sub client.
  this.subClient = redis.createClient(this.port, this.host, this.options);
  this.subClient.on('error', function(err) {
    self.emit('error', err);
    self.setStatus('down');
  });
  this.subClient.on('connect', function() {
    // UGLY HACK: node_redis does not restore pub/sub subscriptions correctly upon
    // reconnect. In fact, the client crashes! Resubscription will be handled at the RedisHAClient level.
    // @see https://github.com/mranney/node_redis/issues/191
    this.subscribe('haredis:gossip:master');
    this.subscription_set = {};
  });
  this.subClient.on('subscribe', function(channel, subscribers) {
    self.emit('subscribe', channel, subscribers);
  });
  this.subClient.on('message', function(channel, data) {
    self.emit('message', channel, data);
  });
};

Node.prototype.setStatus = function(status) {
  if (status != this.status) {
    this.status = status;
    this.emit(status);
  }
};

Node.prototype.toString = function() {
  return this.host + ':' + this.port;
};

module.exports = Node;