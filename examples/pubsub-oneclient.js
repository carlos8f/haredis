var redis = require('../')
  , uuid = require('../lib/uuid')
  ;

redis.debug_mode = true;
var nodes = [6380, 6381, 6382];
var client = redis.createClient(nodes);

client.on('subscribe', function(channel, count) {
  console.log('subscribed to ' + channel + ' on ' + client.subSlave + ' (' + count + ' subs)');
});
client.subscribe('mychannel', function(err, reply) {
  if (err) {
    return console.error(err);
  }
});

var msg_per_sec = 0, pub_per_sec = 0, err_per_sec = 0;
client.on('message', function(channel, message) {
  msg_per_sec++;
});

setInterval(function() {
  var id = uuid();
  client.publish('mychannel', id, function(err, reply) {
    if (err) {
      err_per_sec++;
      return console.error(err);
    }
    pub_per_sec++;
  });
 }, 20);

setInterval(function() {
  console.log(msg_per_sec + ' messages received');
  msg_per_sec = 0;
  console.log(pub_per_sec + ' publishes');
  pub_per_sec = 0;
  if (err_per_sec) {
    console.log(err_per_sec + ' errors');
    err_per_sec = 0;
  }
}, 1000);