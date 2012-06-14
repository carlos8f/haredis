var redis = require('redis')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , Node = require('./lib/node')
  , default_port = 6379
  , default_host = '127.0.0.1'
  , default_retry_timeout = 1000
  , commands = require('./node_modules/redis/lib/commands')
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
    this.drainQueue();
  });
  this.parseNodeList(nodeList, options);
}
util.inherits(RedisHAClient, EventEmitter);

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
      node = this.randomSlave();
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

RedisHAClient.prototype.parseNodeList = function(nodeList, clientOptions) {
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
      var options = {};
      if (/^\d+$/.test(parts[0])) {
        options.port = parseInt(parts[0]);
        options.host = default_host;
      }
      else if (parts.length == 2) {
        options.host = parts[0];
        options.port = parseInt(parts[1]);
      }
      else {
        options.host = parts[0];
        options.port = default_port;
      }
      if (options.host == 'localhost') {
        options.host = '127.0.0.1';
      }
    }
    var node = new Node(options, clientOptions);
    node.on('error', function(err) {
      console.warn(err, 'error on ' + this.host + ':' + this.port);
      if (this.role == 'master') {
        self.failover();
      }
    });
    node.on('role', function() {
      if (this.role == 'master') {
        console.log(this.toString() + ' is master');
        self.master = this;
        self.emit('ready');
      }
    });
    node.on('ping', function(latency) {
      console.log(this.toString() + ' pong with ' + latency + 'ms latency');
    });
    self.nodes.push(node);
  });
};

RedisHAClient.prototype.failover = function() {
  this.ready = false;
};

RedisHAClient.prototype.__defineGetter__('slaves', function() {
  return this.nodes.every(function(node) {
    return node.role == 'slave' && !node.failing;
  });
});

RedisHAClient.prototype.randomSlave = function() {
  return this.slaves[Math.round(Math.random() * this.slaves.length - 1)];
};