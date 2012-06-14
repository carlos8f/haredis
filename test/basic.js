var redis = require('../');

var client = redis.createClient([6379, 6380, 6381]);

client.get('carlos', function(err, reply) {
  console.log(reply);
});