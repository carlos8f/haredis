var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , dns = require('dns')
  , async = require('async')
  ;

function Node(spec, options) {
  var self = this;
  this.host = spec.host;
  this.port = spec.port;
  this.clients = [];
  this.upSince = null;

  options = options || {};
  if (typeof options.no_ready_check == 'undefined') {
    options.no_ready_check = true;
  }
  this.options = {};
  Object.keys(options).forEach(function(k) {
    self.options[k] = options[k];
  });

  this.setStatus('initializing');

  if (this.host.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
    this.connect();
  }
  else {
    // Resolve host, to prevent false duplication
    Node.resolveHost(this.host, function(err, host) {
      if (err) {
        return self.emit('error', err);
      }
      self.host = host;
      self.connect();
    });
  }
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
  this.client = redis.createClient(this.port, this.host, this.options);
  if (this.auth_pass) {
    this.client.auth(this.auth_pass);
  }
  this.clients.push(this.client);
  this.client.on('error', function(err) {
    self.emit('error', err);
  });
  this.client.on('end', function() {
    if (!this.closing) {
      self.setStatus('reconnecting');
      // Client connection closed without quit(). If reconnection fails, the
      // node is considered down.
      setTimeout(function waitForReconnect() {
        if (!self.client.connected) {
          self.emit('error', new Error(self + ' connection dropped and reconnection failed!'));
          self.setStatus('down');
        }
      }, Math.floor(this.retry_delay * this.retry_backoff * 2));
    }
  });
  this.client.on('connect', function() {
    if (self.options.single_mode) {
      // No failover possible, don't check for slave-read-only
      self.setStatus('up');
    }
    else {
      self.client.CONFIG('GET', 'slave-read-only', function(err, reply) {
        if (err) {
          return self.emit('error', err);
        }
        if (reply[1] !== 'yes') {
          self.setStatus('up');
        }
        else {
          console.warn('WARNING! ' + self + ' has slave-read-only mode ON, which breaks haredis failover! slave-read-only automatically turned OFF.');
          self.client.CONFIG('SET', 'slave-read-only', 'no', function(err, reply) {
            if (err) {
              return self.emit('error', err);
            }
            self.setStatus('up');
          });
        }
      });
    }
  });
  this.client.on('monitor', function(time, args) {
    self.emit('monitor', time, args);
  });

  // Maintain a separate pub/sub client.
  this.subClient = redis.createClient(this.port, this.host, this.options);
  if (this.auth_pass) {
    this.subClient.auth(this.auth_pass);
  }
  this.clients.push(this.subClient);
  this.subClient.on('error', function(err) {
    self.emit('error', err);
  });
  this.subClient.on('connect', function() {
    // UGLY HACK: node_redis does not restore pub/sub subscriptions correctly upon
    // reconnect. In fact, the client crashes! Resubscription will be handled at the RedisHAClient level.
    // @see https://github.com/mranney/node_redis/issues/191
    this.subscribe('haredis:gossip:master');
    this.subscription_set = {};
  });

  // Subtract 1 from all counts, for the gossip channel we've set up.
  this.subClient.on('subscribe', function(channel, count) {
    self.emit('subscribe', channel, count - 1);
  });
  this.subClient.on('unsubscribe', function(channel, count) {
    self.emit('unsubscribe', channel, count - 1);
  });
  this.subClient.on('message', function(channel, message) {
    self.emit('message', channel, message);
  });
  this.subClient.on('psubscribe', function(pattern, count) {
    self.emit('psubscribe', pattern, count - 1);
  });
  this.subClient.on('punsubscribe', function(pattern, count) {
    self.emit('punsubscribe', pattern, count - 1);
  });
  this.subClient.on('pmessage', function(pattern, channel, message) {
    self.emit('pmessage', pattern, channel, message);
  });
};

Node.prototype.quit = function(callback) {
  var tasks = [];

  this.clients.forEach(function(client) {
    tasks.push(function(cb) {
      client.quit(cb);
    });
  });
  async.parallel(tasks, function(err, replies) {
    if (callback) {
      callback(err, replies);
    }
  });
};

Node.prototype.setStatus = function(status) {
  if (status != this.status) {
    if (status === 'up') this.upSince = Date.now();
    else this.upSince = null;
    this.status = status;
    this.emit(status);
  }
};

Node.prototype.toString = function() {
  return this.host + ':' + this.port;
};

Node.prototype.uptime = function () {
  if (this.upSince === null) return null;
  return Date.now() - this.upSince;
};

Node.prototype.end = function () {
  this.clients.forEach(function (client) {
    client.end();
  });
  this.emit('end');
};

module.exports = Node;
