var redis = require('../')
  , uuid = require('../lib/uuid')
  ;

var client = redis.createClient([6379, 6380, 6381]);

setInterval(function() {
  var id = uuid();
  client.SET('test', id);
 }, 20);