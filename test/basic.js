var redis = require('../')
  , uuid = require('../lib/uuid')
  ;

redis.debug_mode = true;
var client = redis.createClient([6380, 6381, 6382]);

var cmd_per_sec = 0;
var err_per_sec = 0;

setInterval(function() {
  var id = uuid();
  client.SET('test', id, function(err, reply) {
    if (err) {
      err_per_sec++;
      return console.error(err);
    }
    cmd_per_sec++;
  });
 }, 20);

setInterval(function() {
  console.log(cmd_per_sec + ' commands executed');
  cmd_per_sec = 0;
  if (err_per_sec) {
    console.log(err_per_sec + ' errors');
    err_per_sec = 0;
  }
}, 1000);