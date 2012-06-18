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
  this.clients.push(this.client);
  this.client.on('error', function(err) {
    self.emit('error', err);
  });
  this.client.on('end', function() {
    if (!this.closing) {
      self.setStatus('down');
    }
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
  this.clients.push(this.subClient);
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

Node.prototype.incrOpcounter = function(count, done) {
  // Master-only operation
  if (this.role != 'master') {
    return;
  }
  if (typeof count == 'function') {
    done = count;
    count = 1;
  }
  var self = this;
  // For write operations, increment an op counter, to judge freshness of slaves.
  if (!this.opcounterClient) {
    this.opcounterClient = redis.createClient(this.port, this.host, this.options);
    this.clients.push(this.opcounterClient);
    if (this.options.haredis_db_num) {
      // Make redis connect to a special db (upon ready) for the opcounter.
      this.opcounterClient.selected_db = this.options.haredis_db_num;
    }
    this.opcounterClient.on('error', function(err) {
      self.emit('error', err);
      self.setStatus('down');
    });
  }
  this.opcounterClient.INCRBY('haredis:opcounter', count, done);
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
    this.status = status;
    this.emit(status);
  }
};

Node.prototype.toString = function() {
  return this.host + ':' + this.port;
};

module.exports = Node;