var redis = require('../')
  , uuid = require('../lib/uuid')
  ;

var client = redis.createClient([6379, 6380, 6381]);

var per_sec = 0;

setInterval(function() {
  var id = uuid();
  client.SET('test', id, function(err, reply) {
    if (err) {
      return console.error(err);
    }
    per_sec++;
  });
 }, 20);

setInterval(function() {
  console.log(per_sec + ' commands executed');
  per_sec = 0;
}, 1000);