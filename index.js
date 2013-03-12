var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , Node = require('./lib/node')
  , HAMulti = require('./lib/multi')
  , connection_id = 0
  , commands = require('redis/lib/commands')
  , async = require('async')
  , uuid = require('./lib/uuid')
  ;

require('pkginfo')(module);

var log_level = {};
log_level.debug = 0x01;
log_level.error = 0x02;
log_level.warning = 0x04;
log_level.info = 0x08;

var defaults = {
  port: 6379,
  host: '127.0.0.1',
  lock_time: 1000,
  reorientate_wait: 2000,
  haredis_db_num: 15,
  socket_nodelay: true,
  log_level: log_level.error | log_level.warning | log_level.info,
  opcounterDiviser: 100
};

function createClient(nodes, options, etc) {
  return new RedisHAClient(nodes, options, etc);
}
exports.createClient = createClient;
exports.RedisClient = RedisHAClient;
exports.debug_mode = false;
exports.print = redis.print;
exports.log_level = log_level;

function RedisHAClient(nodeList, options) {
  var self = this;
  this.connection_id = ++connection_id;
  if (typeof arguments[0] == 'undefined' && typeof arguments[1] == 'undefined') {
    options = {single_mode: true};
    nodeList = [defaults.port];
    self.applyDefaults(options);
    self.debug('no arguments passed, starting client in local single server mode');
  }
  else if (!util.isArray(nodeList)) {
    var port = nodeList ? nodeList : defaults.port;
    var host = options ? options : defaults.host;
    nodeList = [host + ':' + port];
    options = typeof arguments[2] != 'undefined' ? arguments[2] : {};
    options.single_mode = true;
    self.applyDefaults(options);
    self.debug('a port/host combo was passed, starting client in single server mode');
  }
  else {
    self.applyDefaults(options);
  }
  EventEmitter.call(this);
  this.orientating = false;
  this.haredis_version = exports.version;

  this.nodes = [];
  this.queue = [];
  this.subscriptions = {};
  this.psubscriptions = {};
  this.selected_db = 0;
  this.connected = false;
  this.ready = false;
  this._slaveOk = false;
  this.opcounter = 0;
  this.on('connect', function() {
    // Mirror some stuff from master client, to better simulate node_redis.
    this.host = this.master.host;
    this.port = this.master.port;
    this.stream = this.master.client.stream;
    this.reply_parser = this.master.client.reply_parser;
    this.send_command = this.master.client.send_command.bind(this.master.client);
    this.connected = true;
    if (this.auth_callback) {
      // Note: response is simulated :) Auth would've happened by now on
      // all nodes.
      this.auth_callback(null, 'OK');
    }
  });
  this.parseNodeList(nodeList, this.options);
}
util.inherits(RedisHAClient, EventEmitter);

RedisHAClient.prototype.applyDefaults = function(options) {
  var self = this;
  options = options || {};
  this.options = {};
  Object.keys(options).forEach(function(k) {
    self.options[k] = options[k];
  });
  Object.keys(defaults).forEach(function(k) {
    if (typeof self.options[k] == 'undefined') {
      self.options[k] = defaults[k];
    }
  });
};

RedisHAClient.prototype.debug = function(message, label) {
  if (this.options.log_level & log_level.debug || exports.debug_mode) {
    arguments[0] = this.logFormat('debug', message);
    console.log.apply(null, arguments);
  }
};
RedisHAClient.prototype.log = function(message, label) {
  if (this.options.log_level & log_level.info || exports.debug_mode) {
    arguments[0] = this.logFormat('info', message);
    console.log.apply(null, arguments);
  }
};
RedisHAClient.prototype.warn = function(message, label) {
  if (this.options.log_level & log_level.warning || exports.debug_mode) {
    arguments[0] = this.logFormat('warning', message);
    console.log.apply(null, arguments);
  }
};
RedisHAClient.prototype.error = function(message, label) {
  if (this.options.log_level & log_level.error || exports.debug_mode) {
    arguments[0] = this.logFormat('ERROR', message);
    console.error.apply(null, arguments);
  }
};
RedisHAClient.prototype.logFormat = function(type, message) {
  return util.format('[%s](haredis#%d) %s: %s', new Date().toTimeString().split(' ')[0], this.connection_id, type, message);
};

RedisHAClient.prototype.onReady = function() {
  var self = this;
  this.designateSubSlave(function(err) {
    if (err) {
      self.ready = false;
      return self.reorientate('unable to designate subslave');
    }
    self.ready = true;
    self.orientating = false;
    function onDrain() {
      self.emit('drain');
    }
    function onIdle() {
      if (self.queue.length === 0) {
        self.emit('idle');
      }
    }
    self.nodes.forEach(function(node) {
      node.client.removeListener('drain', onDrain);
      node.client.removeListener('idle', onIdle);
    });
    if (!self.server_info) {
      self.debug('ready, using ' + self.master + ' as master');
    }
    else {
      self.warn('orientate complete, using ' + self.master + ' as master');
    }
    self.master.client.on('drain', onDrain);
    self.master.client.on('idle', onIdle);
    self.server_info = self.master.info;

    self.emit('connect');
    self.emit('ready');
    self.drainQueue();
  });
};

RedisHAClient.prototype.slaveOk = RedisHAClient.prototype.slaveOK = function(command) {
  if (command) {
    return this._slaveOk && this.isRead(command);
  }
  this._slaveOk = true;
  return this;
};

commands.forEach(function(k) {
  commands.push(k.toUpperCase());
});

commands.forEach(function(k) {
  RedisHAClient.prototype[k] = function() {
    var args = Array.prototype.slice.call(arguments);
    var self = this;
    k = k.toLowerCase();
    if (k == 'multi') {
      return new HAMulti(this, args[0]);
    }
    if (!this.ready) {
      // @todo: create a custom multi() method which can return a chainable thing
      // instead here.
      this.queue.push([k, args]);
      return;
    }

    var skipOpcounter = false;
    switch (k) {
      case 'subscribe':
      case 'unsubscribe':
      case 'psubscribe':
      case 'punsubscribe':
        // Maintain a hash of subscriptions, so we can move subscriptions around to
        // different slaves.
        var type = k[0] == 'p' ? 'psubscriptions' : 'subscriptions';
        var unsub = k.indexOf('unsub') !== -1;
        for (var i in args) {
          if (typeof args[i] == 'string') {
            if (unsub) {
              delete this[type][args[i]];
            }
            else {
              this[type][args[i]] = true;
            }
          }
        }
        self.debug(k + ' on ' + this.subSlave);
        return callCommand(this.subSlave.subClient, k, args, true);
      case 'select':
        // Need to execute on all nodes.
        // Execute on master first in case there is a callback.
        this.selected_db = parseInt(args[0]);
        callCommand(this.master.client, k, args, true);
        // Execute on slaves without a callback.
        this.slaves.forEach(function(node) {
          callCommand(node.client, k, [args[0]], true);
        });
        return;
      case 'quit':
        self.debug('got quit');
        var tasks = [];
        this.up.forEach(function(node) {
          tasks.push(function(cb) {
            node.quit(cb);
          });
        });
        async.parallel(tasks, function(err, replies) {
          self.emit('end');
          self.debug('done quitting');
          if (typeof args[0] == 'function') {
            args[0](err);
          }
        });
        return;
      case 'monitor':
      case 'info':
      case 'config':
      case 'publish':
        skipOpcounter = true;
        break;
    }

    var client, node;
    if (this.options.auto_slaveok || this.slaveOk(k)) {
      if (node = this.randomSlave()) {
        self.debug(k + ' on ' + node);
        client = node.client;
      }
    }

    callCommand(client, k, args, skipOpcounter);

    function callCommand(client, command, args, skipOpcounter) {
      self._slaveOk = false;
      if (!client) {
        self.debug(command + ' on ' + self.master + ' (master default)');
        client = self.master.client;
      }
      client[command].apply(client, args);
      // Increment opcounter if necessary.
      if (!self.isRead(command, args) && !skipOpcounter) {
        self.incrOpcounter(function(err) {
          if (err) {
            // Will trigger failover!
            return self.master.emit('err', err);
          }
        });
      }
    }
  };
});

RedisHAClient.prototype.incrOpcounter = function(count, done) {
  if (typeof count == 'function') {
    done = count;
    count = 1;
  }
  if (this.options.single_mode) {
    done();
    return;
  }
  var master = this.master;
  // For write operations, increment an op counter, to judge freshness of slaves.
  if (!master.opcounterClient) {
    master.opcounterClient = redis.createClient(master.port, master.host, this.options);
    if (master.auth_pass) {
      master.opcounterClient.auth(master.auth_pass);
    }
    master.clients.push(master.opcounterClient);
    if (this.options.haredis_db_num) {
      // Make redis connect to a special db (upon ready) for the opcounter.
      master.opcounterClient.selected_db = this.options.haredis_db_num;
    }
    master.opcounterClient.on('error', function(err) {
      master.emit('error', err);
    });
  }
  if (this.opcounter++ % this.options.opcounterDiviser === 0) {
    master.opcounterClient.INCRBY('haredis:opcounter', count, done);
  }
  else {
    done();
  }
};

// Stash auth for connect and reconnect.  Send immediately if already connected.
RedisHAClient.prototype.auth = RedisHAClient.prototype.AUTH = function () {
  var args = Array.prototype.slice.call(arguments);
  var self = this;
  this.auth_callback = args[1];
  var authList = args[0];
  if (typeof authList == 'object'){
    this.nodes.forEach(function(node) {
      var auth_pass = authList[node.host + ':' + node.port];
      if (auth_pass) {
        node.auth_pass = auth_pass;
      }
    });
  } else {
    this.nodes.forEach(function(node) {
      node.auth_pass = authList;
    });
  }
};

RedisHAClient.prototype.isRead = function(command, args) {
  switch (command.toLowerCase()) {
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
    case 'pttl':
    case 'scard':
    case 'sinter':
    case 'sismember':
    case 'smembers':
    case 'srandmember':
    case 'strlen':
    case 'sunion':
    case 'ttl':
    case 'type':
    case 'zcard':
    case 'zrange':
    case 'zrangebyscore':
    case 'zrank':
    case 'zrevrange':
    case 'zrevrangebyscore':
    case 'zrevrank':
    case 'zscore':
      return true;
    case 'sort':
      // @todo: parse to see if "store" is used
      return false;
    default: return false;
  }
};

RedisHAClient.prototype.designateSubSlave = function(callback) {
  var self = this, tasks = [];
  if (this.subSlave) {
    if (this.subSlave.status == 'up') {
      if (!this.isMaster(this.subSlave)) {
        self.debug('still using ' + this.subSlave + ' as subSlave');
      }
      else if (this.slaves.length > 0) {
        self.log('renegotating subSlave away from master');
        var oldSubSlave = this.subSlave;
        Object.keys(self.subscriptions).forEach(function(channel) {
          tasks.push(function(cb) {
            self.log('unsubscribing ' + channel + ' on ' + oldSubSlave);
            oldSubSlave.subClient.unsubscribe(channel, cb);
          });
        });
        Object.keys(self.psubscriptions).forEach(function(pattern) {
          tasks.push(function(cb) {
            self.log('punsubscribing ' + pattern + ' on ' + oldSubSlave);
            oldSubSlave.subClient.punsubscribe(pattern, cb);
          });
        });
        this.subSlave = this.randomSlave();
        self.log('subSlave is now ' + this.subSlave);
      }
    }
    else {
      this.subSlave = this.randomSlave();
      if (this.subSlave) {
        self.warn('subSlave went down, renegotiated to ' + this.subSlave);
      }
    }
  }
  else if (this.slaves.length) {
    this.subSlave = this.randomSlave();
    self.debug('designated ' + this.subSlave + ' as subSlave');
  }
  if (!this.subSlave) {
    this.subSlave = this.master;
    self.debug('defaulting to master as subSlave');
  }

  Object.keys(this.subscriptions).forEach(function(channel) {
    tasks.push(function(cb) {
      self.debug('subscribing ' + channel + ' on ' + self.subSlave);
      self.subSlave.subClient.subscribe(channel, cb);
    });
  });
  Object.keys(this.psubscriptions).forEach(function(pattern) {
    tasks.push(function(cb) {
      self.debug('psubscribing ' + pattern + ' on ' + self.subSlave);
      self.subSlave.subClient.psubscribe(pattern, cb);
    });
  });

  async.parallel(tasks, callback);
};

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
      spec = n;
    }
    else {
      if (typeof n == 'number') {
        n = n + "";
      }
      var parts = n.split(':');
      var spec = {};
      if (/^\d+$/.test(parts[0])) {
        spec.port = parseInt(parts[0]);
        spec.host = defaults.host;
      }
      else if (parts.length == 2) {
        spec.host = parts[0];
        spec.port = parseInt(parts[1]);
      }
      else {
        spec.host = parts[0];
        spec.port = defaults.port;
      }
    }
    var node = new Node(spec, options);
    node.on('up', function() {
      self.debug(this + ' is up');
      if (self.responded.length == nodeList.length) {
        if (self.ready) {
          self.reorientate('evaluating ' + this);
        }
        else {
          self.orientate('looking for master');
        }
      }
    });
    node.on('reconnecting', function() {
      if (self.isMaster(this)) {
        self.warn('MASTER connection dropped, reconnecting...');
      }
      else {
        self.warn(this + ' connection dropped, reconnecting...');
      }
      self.connected = false;
      self.ready = false;
      // @todo: pass some real attempts/timers here
      self.emit('reconnecting', {});
    });
    node.on('down', function() {
      if (self.isMaster(this)) {
        self.error('MASTER is down! (' + this + ')');
      }
      else {
        self.error(this + ' is down!');
      }
      self.connected = false;
      self.ready = false;
      // @todo: pass some real attempts/timers here
      self.emit('reconnecting', {});
      self.reorientate('node down');
    });
    node.on('error', function(err) {
      if (self.listeners('error').length) {
        self.emit('error', err);
      }
      else {
        self.warn(err);
      }
    });
    node.on('subscribe', function(channel, count) {
      if (channel != 'haredis:gossip:master') {
        self.emit('subscribe', channel, count);
      }
    });
    node.on('unsubscribe', function(channel, count) {
      self.emit('unsubscribe', channel, count);
    });
    node.on('message', function(channel, message) {
      if (channel == 'haredis:gossip:master') {
        self.warn('gossip said ' + message + ' was promoted!');
        if (!self.orientating && (!self.master || self.master.toString() != message)) {
          var node = self.nodeFromKey(message);
          if (!node) {
            return self.warn("can't find gossiped master!");
          }
          if (node.status == 'up') {
            self.log('switching master...');
            self.master = node;
            self.master.role = 'master';
            self.onReady();
          }
          else {
            // Hasten reconnect
            if (node.client.retry_timer) {
              clearInterval(node.client.retry_timer);
            }
            self.log('hastening reconnect...');
            node.client.stream.connect(node.port, node.host);
          }
        }
      }
      else {
        self.emit('message', channel, message);
      }
    });
    node.on('monitor', function(time, args) {
      self.emit('monitor', time, args);
    });
    self.nodes.push(node);
  });
};

RedisHAClient.prototype.orientate = function(why) {
  var self = this;
  if (this.ready || this.orientating) {
    return;
  }
  self.debug('orientating (' + why + ', ' + this.up.length + '/' + this.nodes.length + ' nodes up) ...');
  this.orientating = true;
  if (this.retryInterval) {
    clearInterval(this.retryInterval);
  }
  var tasks = [];
  this.ready = false;
  if ((this.up.length / this.down.length) <= 0.5) {
    self.warn('refusing to orientate without a majority up!');
    return this.reorientate(why);
  }
  this.up.forEach(function(node) {
    tasks.push(function(cb) {
      node.client.INFO(function(err, reply) {
        if (err) {
          node.client.emit('error', err);
          // Purposely don't pass err to cb so parallel() can continue
          return cb(null, node);
        }
        var info = node.info = Node.parseInfo(reply);
        node.role = info.role;
        if (info.loading && info.loading !== '0') {
          err = new Error(node + ' still loading');
          return cb(err);
        }
        else if (info.master_host) {
          // Resolve the host to prevent false duplication
          Node.resolveHost(info.master_host, function(err, host) {
            if (err) {
              node.client.emit('error', err);
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
    if (err) {
      self.warn(err);
      return self.reorientate(why);
    }
    var masters = []
      , slaves = []
      , master_host
      , master_port
      , master_conflict = false
      ;
    nodes.forEach(function(node) {
      if (node.info.role == 'master') {
        masters.push(node);
      }
      else if (node.info.role == 'slave') {
        if (master_host && (master_host != node.info.master_host || master_port != node.info.master_port)) {
          master_conflict = true;
        }
        master_host = node.info.master_host;
        master_port = node.info.master_port;
        slaves.push(node);
      }
    });
    if (masters.length != 1) {
      // Resolve multiple/no masters
      self.warn('invalid master count: ' + masters.length);
      self.failover();
    }
    else if (slaves.length && (master_conflict || master_host != masters[0].host || master_port != masters[0].port)) {
      self.warn('master conflict detected');
      self.failover();
    }
    else {
      self.master = masters.pop();
      self.onReady();
    }
  });
};

RedisHAClient.prototype.makeSlave = function(node, cb) {
  var self = this;
  if (!this.master) {
    return self.error("can't make " + node + " a slave of unknown master!");
  }
  if (node.host == this.master.host && node.port == this.master.port) {
    return self.error('refusing to make ' + node + ' a slave of itself!');
  }
  self.log('making ' + node + ' into a slave...');
  node.client.SLAVEOF(this.master.host, this.master.port, function(err, reply) {
    if (err) {
      return cb(err);
    }
    node.role = 'slave';
    self.debug(node + ' is slave');
    cb();
  });
};

RedisHAClient.prototype.failover = function() {
  var self = this;
  if (this.ready) {
    return self.warn('ignoring failover while ready');
  }
  self.warn('attempting failover!');
  var tasks = [];
  var id = uuid();
  self.warn('my failover id: ' + id);
  // We can't use a regular EXPIRE call because of a bug in redis which prevents
  // slaves from expiring keys correctly.
  var was_error = false;
  this.up.forEach(function(node) {
    tasks.push(function(cb) {
      if (self.selected_db == self.options.haredis_db_num) {
        // If we are in the haredis_db_num, ignore this.
        return cb();
      }
      // Switch to the opcounter db.
      node.client.SELECT(self.options.haredis_db_num, function(err) {
        if (err) {
          self.error(err, 'error switching to opcounter db');
          was_error = true;
        }
        cb();
      });
    });
    tasks.push(function(cb) {
      if (was_error) {
        return cb();
      }
      node.client.MULTI()
        .SETNX('haredis:failover', id + ':' + Date.now())
        .GET('haredis:failover', function(err, reply) {
          reply = reply.split(':');
          if (reply[0] != id && (Date.now() - reply[1] < self.options.lock_time)) {
            self.warn('failover already in progress: ' + reply[0]);
            // Don't pass the error, so series() can continue.
            was_error = true;
            return cb();
          }
        })
        .EXEC(function(err, replies) {
          if (was_error) {
            return;
          }
          if (err) {
            self.error(err, 'error locking node');
            // Don't pass the error, so series() can continue.
            was_error = true;
            return cb();
          }
          else {
            // set a shortish ttl on the lock. Note that this doesn't actually work...
            node.client.EXPIRE('haredis:failover', 5, function(err) {
              if (err) {
                self.error(err, 'error setting ttl on lock');
              }
            });

            node.client.GET('haredis:opcounter', function(err, opcounter) {
              if (err) {
                self.error(err, 'error getting opcounter');
                // Don't pass the error, so parallel() can continue.
                was_error = true;
              }
              else {
                node.opcounter = opcounter;
              }
              cb(null, node);
            });
          }
        });
    });
    tasks.push(function(cb) {
      if (self.selected_db == self.options.haredis_db_num) {
        // If we are in the haredis_db_num, ignore this.
        return cb();
      }
      // Switch to the normal db.
      node.client.SELECT(self.selected_db, function(err) {
        if (err) {
          self.error(err, 'error switching from opcounter db');
          was_error = true;
        }
        cb();
      });
    });
  });
  async.series(tasks, function(err, results) {
    if (results.length) {
      if (!was_error) {
        self.log('lock was a success!');
      }
      else {
        results.forEach(function(node) {
          if (node && node.client) {
            node.client.SELECT(self.options.haredis_db_num, function(err) {
              if (err) {
                return self.error(err, 'error selecting db to unlock ' + node);
              }
              node.client.DEL('haredis:failover', function(err) {
                if (err) {
                  return self.error(err, 'error unlocking ' + node);
                }
                node.client.SELECT(self.selected_db, function(err) {
                  if (err) {
                    return self.error(err, 'error unlocking ' + node);
                  }
                  self.debug('unlocked ' + node);
                });
              });
            });
          }
        });
      }
    }
    if (err) {
      self.warn(err);
    }
    if (was_error) {
      return self.reorientate('error during failover');
    }
    else {
      // We've succeeded in locking all the nodes. Now elect our new master...
      var winner;
      results.forEach(function(node) {
        if (node) {
          if (!winner || node.opcounter > winner.opcounter) {
            winner = node;
          }
        }
      });
      if (winner) {
        self.warn('elected ' + winner + ' as master!');
      }
      else {
        return self.reorientate('election had no winner!?');
      }

      winner.client.SLAVEOF('NO', 'ONE', function(err) {
        if (err) {
          self.error(err, 'error electing master');
          return self.reorientate('error electing master');
        }
        self.master = winner;
        self.master.role = 'master';

        var tasks = [];
        self.up.forEach(function(node) {
          if (!self.isMaster(node)) {
            tasks.push(function(cb) {
              self.makeSlave(node, cb);
            });
          }
        });
        if (tasks.length) {
          async.parallel(tasks, function(err) {
            if (err) {
              return self.error(err, 'error making slave!');
            }
            self.debug('publishing gossip:master for ' + self.master.toString());
            self.master.client.publish('haredis:gossip:master', self.master.toString());
            self.onReady();
          });
        }
        else {
          self.onReady();
        }
      });
    }
  });
};

RedisHAClient.prototype.isMaster = function(node) {
  return this.master && this.master.toString() == node.toString();
};

RedisHAClient.prototype.reorientate = function(why) {
  var self = this;
  this.orientating = false;
  self.warn('reorientating (' + why + ') in ' + self.options.reorientate_wait + 'ms');
  this.retryInterval = setTimeout(function() {
    self.orientate(why);
  }, self.options.reorientate_wait);
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
  return this.slaves[Math.round(Math.random() * (this.slaves.length - 1))];
};