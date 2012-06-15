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
    node.on('up', function() {
      console.log(this + ' is up');
      if (self.responded.length == nodeList.length) {
        self.orientate();
      }
    });
    node.on('down', function() {
      console.log(this + ' is down');
      if (self.responded.length == nodeList.length) {
        self.orientate();
      }
    });
    node.on('error', function(err) {
      console.warn(err);
    });
    self.nodes.push(node);
  });
};

RedisHAClient.prototype.orientate = function() {
  var tasks = [], self = this;
  this.ready = false;
  this.nodes.forEach(function(node) {
    tasks.push(function(cb) {
      node.client.INFO(function(err, reply) {
        var info = node.info = Node.parseInfo(reply);
        node.role = info.role;
        if (err) {
          node.emit('error', err);
          // Purposely don't pass err to cb so parallel() can continue
          return cb(null, node);
        }
        else if (info.loading && info.loading !== '0') {
          // Node is still loading. Try again later...
          var retry_time = info.loading_eta_seconds * 1000;
          err = new Error(node + ' still loading, trying again in ' + retry_time + 'ms');
          setTimeout(function () {
            self.orientate();
          }, retry_time);
          return cb(err);
        }
        else if (info.master_host) {
          // Resolve the host to prevent false duplication
          Node.resolveHost(info.master_host, function(err, host) {
            if (err) {
              node.emit('error', err);
              // Purposely don't pass err so parallel() can continue
              return cb(null, node);
            }
            node.info.master_host = host;
            cb(null, node);
          });
        }
        else {
          // Node is a master
          cb(null, node);
        }
      });
    });
  });
  async.parallel(tasks, function(err, nodes) {
    var masters = []
      , slaves = []
      , master_host
      , master_port
      , master_conflict = false
      ;
    nodes.forEach(function(node) {
      if (!node.info) {
        // Node is down
        return;
      }
      if (node.info.role == 'master') {
        masters.push(node);
      }
      else if (node.info.role == 'slave') {
        if (master_host && master_host != node.info.master_host) {
          master_conflict = true;
        }
        master_host = node.info.master_host;
        master_port = node.info.master_port;
        slaves.push(node);
      }
    });
    if (masters.length != 1) {
      // Resolve multiple/no masters
      console.warn('invalid master count: ' + masters.length);
      self.failover();
    }
    else if (master_conflict || master_host != masters[0].host || master_port != masters[0].port) {
      console.warn('master conflict detected');
      self.failover();
    }
    else {
      self.master = masters.pop();
      self.emit('ready');
    }
  });
};

RedisHAClient.prototype.makeSlave = function(node) {
  if (!this.master) {
    return console.error("can't make " + node + " a slave of unknown master!");
  }
  if (node.host == this.master.host && node.port == this.master.port) {
    return console.warn('refusing to make ' + node + ' a slave of itself!');
  }
  console.log('making ' + node + ' into a slave...');
  node.client.SLAVEOF(this.master.host, this.master.port, function(err, reply) {
    if (err) {
      return console.error(err, 'error setting slaveof');
    }
    console.log(node + ' is slave');
  });
};

RedisHAClient.prototype.failover = function() {
  if (this.ready) {
    return console.log('ignoring failover while ready');
  }
  if (this.failoverInProgress) {
    return console.warn('failover already in progress');
  }
  if (this.up / this.down <= 0.5) {
    return console.log("refusing to failover without a majority up");
    return self.retryFailover();
  }
  this.failoverInProgress = true;
  console.log('attempting failover!');
  var tasks = [];
  var id = uuid();
  console.log('my failover id: ' + id);
  var self = this;
  this.up.forEach(function(node) {
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
              console.error(err, 'error setting ttl on lock');
            }
          });
        })
        .EXEC(function(err, replies) {
          cb(err, node);
        });
    });
  });
  async.parallel(tasks, function(err, results) {
    if (err) {
      if (results) {
        console.log('rolling back locked nodes...');
        results.forEach(function(node) {
          if (node) {
            node.client.DEL('haredis:failover', function(err) {
              if (err) {
                return console.error(err, 'error rolling back ' + node);
              }
              console.log('rolled back ' + node);
            });
          }
        });
      }
      return self.retryFailover();
    }
    else {
      // We've succeeded in locking all the nodes. Now elect our new master...
      var votes = {}, last_io_slave;
      results.forEach(function(node) {
        if (!node.info) {
          console.log('no info for ' + node + '?');
          return;
        }
        switch (node.info.role) {
          case 'slave':
            var key = node.info.master_host + ':' + node.info.master_port;
            if (node.info.master_link_status == 'up' && self.isUp(key)) {
              // Slave points to a healthy master.
              votes[key] = typeof votes[key] == 'undefined' ? 1 : votes[key] + 1;
            }
            else {
              // Slave points to a downed master. A backup plan will be using
              // the slave with freshest data.
              if (!last_io_slave || node.info.master_last_io_seconds_ago < last_io_slave.info.master_last_io_seconds_ago) {
                last_io_slave = node;
              }
            }
            break;
          case 'master':
            // Node claims to be master. They need at least one connected slave
            // (2 votes) to be honored.
            var key = node.toString();
            votes[key] = typeof votes[key] == 'undefined' ? 1 : votes[key] + 1;
            break;
        }
      });
      var winner, high, tie = [];
      Object.keys(votes).forEach(function(key) {
        var num = votes[key];
        if (num < 2) {
          return;
        }
        if (!high || num > high) {
          high = num;
          winner = key;
        }
        else if (num == high) {
          tie.push(key);
          delete winner;
        }
      });
      if (winner) {
        console.log(winner + ' received ' + high + ' votes, congrats!');
        winner = self.nodeFromKey(winner);
      }
      else if (tie.length) {
        console.log('election was a tie: ' + tie + ' using tiebraker: uptime');
        tie.forEach(function(key) {
          var node = self.nodeFromKey(key);
          if (!winner || node.info.uptime_in_seconds > winner.info.uptime_in_seconds) {
            winner = node;
          }
        });
        console.log(winner + ' elected from highest uptime_in_seconds');
      }
      else if (last_io_slave) {
        console.log(last_io_slave + ' elected from lowest master_last_io');
        winner = last_io_slave;
      }

      if (!winner) {
        console.error('election had no winner!?');
        return self.retryFailover();
      }

      winner.client.SLAVEOF('NO', 'ONE', function(err) {
        if (err) {
          console.error(err, 'error electing master');
          return self.retryFailover();
        }
        self.master = winner;
        self.master.role = 'master';
        self.emit('ready');

        self.up.forEach(function(node) {
          if (!self.isMaster(node)) {
            self.makeSlave(node);
          }
        });
      });
    }
  });
};

RedisHAClient.prototype.isMaster = function(node) {
  return this.master && this.master.toString() == node.toString();
};

RedisHAClient.prototype.retryFailover = function() {
  var self = this;
  console.log('retrying failover in ' + default_failover_wait + 'ms');
  setTimeout(function() {
    self.failoverInProgress = false;
    self.orientate();
  }, default_failover_wait);
};

RedisHAClient.prototype.__defineGetter__('slaves', function() {
  return this.nodes.filter(function(node) {
    return node.role == 'slave' && node.status == 'up';
  });
});

RedisHAClient.prototype.__defineGetter__('responded', function() {
  return this.nodes.filter(function(node) {
    return node.status != 'initializing';
  });
});

RedisHAClient.prototype.__defineGetter__('up', function() {
  return this.nodes.filter(function(node) {
    return node.status == 'up';
  });
});

RedisHAClient.prototype.__defineGetter__('down', function() {
  return this.nodes.filter(function(node) {
    return node.status == 'down';
  });
});

RedisHAClient.prototype.isUp = function(key) {
  return this.nodes.some(function(node) {
    return node.toString() == key && node.status == 'up';
  });
};

RedisHAClient.prototype.nodeFromKey = function(key) {
  return this.nodes.filter(function(node) {
    return node.toString() == key;
  })[0];
};

RedisHAClient.prototype.randomSlave = function() {
  return this.slaves[Math.round(Math.random() * this.slaves.length - 1)];
};