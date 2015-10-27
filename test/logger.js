var haredis = require('../');
var assert = require('assert');

describe('custom logger', function () {
  beforeEach(makeServers);
  afterEach(shutdownServers);

  function objValues(obj){
    var values = [];
    Object.keys(obj).forEach(function(key){
      values.push(obj[key]);
    });
    return values;
  }

  function findLog(log_msg, type, text){
    return log_msg.filter(function(log){
      var rex = new RegExp(text);
      return log.type === type && log.args.some(function(arg){ return rex.test(arg); });
    });
  }

  it('should collect log messages with a custom logger', function (done) {
    var log_msg = [];
  
  	function debug(message, label){
      log_msg.push({type:'debug', args:objValues(arguments)});
  	}

  	function log(message, label) {
      log_msg.push({type:'log', args:objValues(arguments)});
  	}

  	function warn(message, label) {
      log_msg.push({type:'warn', args:objValues(arguments)});
  	}

  	function error(message, label) {
      log_msg.push({type:'error', args:objValues(arguments)});
  	}

    var logger = {
    	debug: debug,
    	log:   log,
    	warn:  warn,
    	error: error
  	};

    var ports = ['127.0.0.1:6380', 'localhost:6381', 6382];
    var client = haredis.createClient(ports, {logger:logger});

    client.once('connect', function(){
      assert.equal(1, findLog(log_msg, 'log', '^lock was a success!$').length);
      assert.equal(1, findLog(log_msg, 'warn', '^elected .* as master!$').length);
      assert.equal(2, findLog(log_msg, 'log', '^making .* into a slave...$').length);
      done();
    });

  });

  it('should display log messages with the default logger', function (done) {
    var _console_log = console.log,
        _console_err = console.error;
    var log_msg = [];

    console.log = function(){
      log_msg.push({type:'log', args:objValues(arguments)});
    }
    
    console.error = function(){
      log_msg.push({type:'error', args:objValues(arguments)});
    }

    var ports = ['127.0.0.1:6380', 'localhost:6381', 6382];
    var client = haredis.createClient(ports);

    client.once('connect', function(){
      console.log = _console_log;
      console.error = _console_err;

      assert.equal(1, findLog(log_msg, 'log', '^.{21} info\: lock was a success!$').length);
      assert.equal(1, findLog(log_msg, 'log', '^.{21} warning\: elected .* as master!$').length);
      assert.equal(2, findLog(log_msg, 'log', '^.{21} info\: making .* into a slave...$').length);
      done();
    });

  });

});

