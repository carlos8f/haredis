var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , Node = require('./lib/node')
  , default_port = 6379
  , default_host = '127.0.0.1'
  , default_retry_timeout = 1000
  , default_failover_wait = 10000
  , commands = require('./node_modules/redis/lib/commands')
  , async = require('async')
  , uuid = require('./lib/uuid')
  ;

function createClient(nodes, options) {
  return new RedisHAClient(nodes, options);
}
exports.createClient = createClient;

function RedisHAClient(nodeList, options) {
  EventEmitter.call(this);
  options = options || {};
  this.retryTimeout = options.retryTimeout || default_retry_timeout;
  this.nodes = [];
  this.queue = [];
  this.ready = false;
  this.on('ready', function() {
    this.ready = true;
    this.failoverInProgress = false;
    this.drainQueue();
  });
  this.parseNodeList(nodeList, options);
}
util.inherits(RedisHAClient, EventEmitter);

commands.forEach(function(k) {
  commands.push(k.toUpperCase());
});

commands.forEach(function(k) {
  RedisHAClient.prototype[k] = function() {
    var args = Array.prototype.slice.call(arguments);
    if (!this.ready) {
      // @todo: create a custom multi() method which can return a chainable thing
      // instead here.
      this.queue.push([k, args]);
      return;
    }
    var preferSlave = false, node;
    switch(k.toLowerCase()) {
      case 'bitcount':
      case 'get':
      case 'getbit':
      case 'getrange':
      case 'hget':
      case 'hgetall':
      case 'hkeys':
      case 'hlen':
      case 'hmget':
      case 'hvals':
      case 'keys':
      case 'lindex':
      case 'llen':
      case 'lrange':
      case 'mget':
      case 'psubscribe':
      case 'pttl':
      case 'punsubscribe':
      case 'scard':
      case 'sinter':
      case 'sismember':
      case 'smembers':
      case 'srandmember':
      case 'strlen':
      case 'subscribe':
      case 'sunion':
      case 'ttl':
      case 'type':
      case 'unsubscribe':
      case 'zcard':
      case 'zrange':
      case 'zrangebyscore':
      case 'zrank':
      case 'zrevrange':
      case 'zrevrangebyscore':
      case 'zrevrank':
      case 'zscore':
        preferSlave = true;
        break;
      case 'sort':
        // @todo: parse to see if "store" is used
        break;
    }
    if (preferSlave) {
      //node = this.randomSlave();
    }
    if (!node) {
      node = this.master;
    }
    return node.client[k].apply(node.client, args);
  };
});

RedisHAClient.prototype.drainQueue = function() {
  if (this.ready && this.queue.length) {
    // Call the next command in the queue
    var item = this.queue.shift();
    this[item[0]].apply(this, item[1]);

    // Wait till nextTick to do next command
    var self = this;
    process.nextTick(function() {
      self.drainQueue();
    });
  }
};

RedisHAClient.prototype.parseNodeList = function(nodeList, options) {
  var self = this;
  nodeList.forEach(function(n) {
    if (typeof n == 'object') {
      options = n;
    }
    else {
      if (typeof n == 'number') {
        n = n + "";
      }
      var parts = n.split(':');
      var spec = {};
      if (/^\d+$/.test(parts[0])) {
        spec.port = parseInt(parts[0]);
        spec.host = default_host;
      }
      else if (parts.length == 2) {
        spec.host = parts[0];
        spec.port = parseInt(parts[1]);
      }
      else {
        spec.host = parts[0];
        spec.port = default_port;
      }
    }
    var node = new Node(spec, options);
    node.on('error', function(err) {
      console.warn(err);
      // Label node as down, possibly failover
      this.setStatus('down');
      if (this.role == 'master') {
        self.failover();
      }
    });
    node.on('role', function() {
      if (this.role == 'master') {
        if (self.master && self.master.status != 'down') {
          // Already have a good master, so there is a duplicate. Make it a slave
          // of our master.
          return self.makeSlave(this);
        }
        else {
          self.master = this;
          self.emit('ready');
        }
      }
      console.log(this.toString() + ' is ' + this.role);
    });
    node.on('gossip', function(info) {
      if (!self.master) {
        // Get the master from slave gossip
        self.nodes.forEach(function(n) {
          if (info.master_host == n.host && info.master_port == n.port) {
            console.log('got master (' + n.toString() + ') from ' + node.toString() + "'s gossip. thanks!");
            n.role = 'master';
            self.master = n;
          }
        });
        if (!self.master) {
          console.warn(this.toString() + ' has ' + info.master_host + ':' + info.master_port + ' as master, but not found in nodes!');
        }
      }
    });
    node.on('status', function() {
      console.log(this.toString() + ' is ' + this.status);
    });
    self.nodes.push(node);
  });
};

RedisHAClient.prototype.makeSlave = function(node) {
  if (!this.master) {
    return console.error("can't make " + node.toString() + " a slave of unknown master!");
  }
  if (node.host == this.master.host && node.port == this.master.port) {
    return console.warn('refusing to make ' + node.toString() + ' a slave of itself!');
  }
  console.log('making ' + node.toString() + ' into a slave...');
  node.client.SLAVEOF(this.master.host, this.master.port, function(err, reply) {
    if (err) {
      return console.error(err, 'error setting slaveof');
    }
    console.log(node.toString() + ' is slave');
  });
};

RedisHAClient.prototype.failover = function() {
  if (this.failoverInProgress) {
    return;
  }
  if (this.slaves.length == 0) {
    return console.log('no slaves to fail over to!');
  }
  this.failoverInProgress = true;
  console.log('attempting failover!');
  this.ready = false;
  var tasks = [];
  var id = uuid();
  console.log('my failover id: ' + id);
  var self = this;
  this.slaves.forEach(function(node) {
    tasks.push(function(cb) {
      node.client.MULTI()
        .SETNX('haredis:failover', id)
        .GET('haredis:failover', function(err, reply) {
          if (reply != id) {
            return cb(new Error('failover already in progress: ' + reply));
          }
          // set a shortish ttl on the lock
          node.client.EXPIRE('haredis:failover', 5, function(err) {
            if (err) {
              console.error(err);
            }
          });
        })
        .EXEC(function(err, replies) {
          if (err) {
            return cb(err);
          }
          node.client.INFO(function(err, info) {
            if (err) {
              return cb(err);
            }
            node.info = info;
            cb(null, node);
          });
        });
    });
  });
  async.parallel(tasks, function(err, results) {
    if (err) {
      console.warn(err, 'error failing over');
      if (results) {
        console.log('rolling back locked nodes...');
        results.forEach(function(node) {
          if (node) {
            node.client.DEL('haredis:failover', function(err) {
              if (err) {
                console.error(err);
              }
            });
          }
        });
      }
      return self.retryFailover();
    }
    else {
      // We've succeeded in locking all the slaves. Now elect our new master...
      var freshest;
      results.forEach(function(node) {
        if (!freshest || node.info.master_last_io_seconds_ago < freshest.info.master_last_io_seconds_ago) {
          freshest = node;
        }
      });
      console.log(freshest.toString() + ' seems freshest.');
      freshest.client.SLAVEOF('NO', 'ONE', function(err) {
        if (err) {
          console.error(err, 'error electing master');
          return self.retryFailover();
        }
        self.master = freshest;
        self.master.role = 'master';
        self.master.setStatus('up');
        self.slaves.forEach(function(node) {
          self.makeSlave(node);
        });
      });
    }
  });
};

RedisHAClient.prototype.retryFailover = function() {
  var self = this;
  // Try failing over again if we still don't have a resolution after waiting.
  setTimeout(function() {
    if (!self.master || self.master != 'up') {
      self.failoverInProgress = false;
      self.failover();
    }
  }, default_failover_wait);
};

RedisHAClient.prototype.__defineGetter__('slaves', function() {
  return this.nodes.filter(function(node) {
    return node.role == 'slave' && node.status == 'up';
  });
});

RedisHAClient.prototype.randomSlave = function() {
  return this.slaves[Math.round(Math.random() * this.slaves.length - 1)];
};